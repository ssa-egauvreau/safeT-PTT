import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  getChannelAiDispatchRow,
  getTransmissionDispatchContext,
} from "../store.js";
import { insertAiDispatchLog, type AiDispatchOutcome } from "./activityLog.js";
import { adaptDispatcherResponseForChannel, detectEmergencyCodeFromTranscript } from "./emergencyCodes.js";
import {
  applyDistressDispatchRules,
  buildDistressTen33Callout,
  detectOfficerDistressFromTranscript,
} from "./distressRules.js";
import { callsignPrefixForRadio, genericInfoLookupFailedLine } from "./lookupSpeech.js";
import { handlePlateFromParse } from "./plateHandler.js";
import { parseDispatcherTransmission } from "./parse.js";
import {
  getAiDispatchPlatformConfig,
  isAiDispatchUnit,
  resolveAiDispatchSystemPrompt,
} from "./platformConfig.js";
import { playMp3UrlOnChannel } from "./playback.js";
import { buildDeterministicDispatchAck } from "./dispatchAck.js";
import { applyOutWithCadRules } from "./outWithCad.js";
import { applyCadDispatchRules } from "./cadDispatchRules.js";
import {
  buildCadPersonLinkFromSubject,
  createPersonOnCallAfterMiss,
  personSearchHadNoMatch,
} from "./cadPersonHelpers.js";
import {
  buildInfoRequestAck,
  buildInfoRequestResponse,
  incidentPayloadHasUnit,
  infoRequestNeedsAsync,
} from "./infoRequest.js";
import { synthesizeElevenLabsMp3, type TtsFailureInfo, type TtsSpeechKind } from "./tts.js";
import { postOutboundWebhook } from "./webhook.js";
import {
  applyChannelTen33Marker,
  startTen33MarkerLoop,
  stopTen33MarkerLoop,
} from "./ten33Marker.js";
import { shouldSkipDuplicateAiDispatch } from "./dedupe.js";
import { retrieveKnowledge } from "./knowledgeBase/retrieve.js";
import { lookupSsaProperty } from "./ssaProperties.js";
import { listTen8ActiveIncidents, upsertTen8Incident } from "../ten8/store.js";
import {
  ten8AddComment,
  ten8AddPerson,
  ten8AddTag,
  ten8AddVehicle,
  ten8Configured,
  ten8CreateIncident,
  ten8GetIncident,
  ten8NewIncidentConfigured,
  ten8RemoveTag,
} from "../ten8/client.js";
import { buildCadPersonLinkBody, findTagIdOnIncident } from "../ten8/cadRadioLookup.js";
import { buildTen8NewIncidentBody } from "../ten8/incidentPayload.js";
import { buildTen8IncidentSeedCoords } from "../ten8/geocode.js";
import {
  extractCallIdFromCreateResponse,
  formatTen8RadioComment,
  isVerifiedOpenCallId,
} from "../ten8/cadComments.js";
import {
  buildTen8AddVehicleBodyCombined,
  formatTen8VehicleLookupComment,
} from "../ten8/vehicles.js";
import type { PlateLookupResult } from "./plateLookup.js";
import type { AiDispatchParseResult } from "./parse.js";

const queue: number[] = [];
let working = false;
let loopbackPort = 8080;

/**
 * Only broadcast a reply for reasonably fresh transmissions. Backfill and post-freeze catch-up
 * re-queue old traffic to populate the activity log; without this gate the dispatcher would key up
 * and replay every missed message on the air. Stale items are still logged, just not spoken.
 */
const MAX_ON_AIR_REPLY_AGE_MS = Number(process.env.AI_DISPATCH_MAX_REPLY_AGE_MS) || 120_000;

export function configureAiDispatchEngine(options: { port: number }): void {
  loopbackPort = options.port;
}

export function getAiDispatchLoopbackPort(): number {
  return loopbackPort;
}

export function enqueueAiDispatchForTransmission(transmissionId: number): void {
  const platform = getAiDispatchPlatformConfig();
  if (!platform.enabled) {
    return;
  }
  queue.push(transmissionId);
  void pump();
}

/** Re-queue recent transmissions on AI-enabled channels that never produced an activity log row. */
export async function backfillAiDispatchActivityLog(): Promise<void> {
  const platform = getAiDispatchPlatformConfig();
  if (!platform.enabled) {
    return;
  }
  try {
    const { listTransmissionIdsMissingAiDispatchLog } = await import("../store.js");
    const ids = await listTransmissionIdsMissingAiDispatchLog(150);
    if (ids.length === 0) {
      return;
    }
    console.log(`[ai-dispatch] backfill: re-queuing ${ids.length} transmission(s) missing activity log`);
    for (const id of ids) {
      queue.push(id);
    }
    void pump();
  } catch (e) {
    console.warn("[ai-dispatch] backfill failed", e);
  }
}

async function pump(): Promise<void> {
  if (working) {
    return;
  }
  working = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift()!;
      await processTransmission(id);
    }
  } finally {
    working = false;
  }
}

function isEmergencyActivation(
  emergencyRegex: ReturnType<typeof detectEmergencyCodeFromTranscript>,
  parsed: AiDispatchParseResult | null,
  officerDistress: boolean,
): boolean {
  return (
    emergencyRegex === "activate" ||
    parsed?.trigger_emergency_tone === true ||
    parsed?.intent === "emergency" ||
    officerDistress
  );
}

function isEmergencyClear(
  emergencyRegex: ReturnType<typeof detectEmergencyCodeFromTranscript>,
  parsed: AiDispatchParseResult | null,
): boolean {
  return emergencyRegex === "clear" || parsed?.intent === "emergency_clear";
}

function defaultTen33Callout(channelName: string): string {
  return `All units 10-33 on ${channelName}, all units 10-33 on ${channelName}.`;
}

/**
 * First 3-5 digit token in a transcript that matches a known SSA property code,
 * used to bias knowledge-base retrieval toward documents tagged to that property.
 * Returns null when no token resolves.
 */
function detectPropertyCode(transcript: string): string | null {
  const tokens = transcript.match(/\b\d{3,5}\b/g);
  if (!tokens) {
    return null;
  }
  for (const token of tokens) {
    if (lookupSsaProperty(token)) {
      return token;
    }
  }
  return null;
}

/** When the model returns chitchat with no script but the officer asked a question. */
function fallbackReplyForSilentParse(
  unit: string | null | undefined,
  transcript: string,
  parsed: AiDispatchParseResult,
): string | null {
  if (parsed.dispatcher_response?.trim()) {
    return null;
  }
  if (!/\?/.test(transcript)) {
    return null;
  }
  const u = unit?.trim();
  if (!u) {
    return "Last unit, 10-9.";
  }
  const csShort = /^27-0[0-3]0$/.test(u) ? u : u.replace(/^27-/, "");
  return `${csShort}, I copy.`;
}

/**
 * Match a unit's transmission to the specific open 10-8 call it refers to: first by the unit
 * being assigned to the call, then by location. Returns null when there's no clear match — we
 * never attach an AI comment to an arbitrary unrelated call.
 */
function findMatchingOpenIncident(
  active: Awaited<ReturnType<typeof listTen8ActiveIncidents>>,
  parsed: AiDispatchParseResult,
  fallbackUnit: string,
): Awaited<ReturnType<typeof listTen8ActiveIncidents>>[number] | null {
  const unit = (parsed.unit ?? fallbackUnit ?? "").trim();
  if (unit) {
    const byUnit = active.find((i) => incidentPayloadHasUnit(i, unit));
    if (byUnit) {
      return byUnit;
    }
  }
  const locName = parsed.location_name?.trim().toLowerCase();
  if (locName) {
    const byName = active.find((i) => (i.location ?? "").toLowerCase().includes(locName));
    if (byName) {
      return byName;
    }
  }
  const locCode = parsed.location_code?.trim();
  if (locCode) {
    const byCode = active.find((i) => (i.location ?? "").includes(locCode));
    if (byCode) {
      return byCode;
    }
  }
  return null;
}

type Ten8ActiveIncident = Awaited<ReturnType<typeof listTen8ActiveIncidents>>[number];

/**
 * Post a CAD comment only when the call exists in our open-incident store (webhook-fed).
 * Never comment on a call id that was guessed or made up — that can crash 10-8.
 */
async function postTen8RadioCommentIfVerified(opts: {
  agencyId: number;
  callId: string;
  active: Ten8ActiveIncident[];
  callsign: string;
  transcript: string;
  commentText?: string | null;
}): Promise<Record<string, unknown>> {
  const callId = opts.callId.trim();
  if (!callId) {
    return { skipped: "empty_call_id" };
  }
  if (!isVerifiedOpenCallId(callId, opts.active)) {
    console.warn(`[ten8] skip comment — call ${callId} not in open incident list`);
    return { skipped: "call_not_verified_open" };
  }
  const shorthand = opts.commentText?.trim();
  const note = shorthand
    ? `${opts.callsign.trim()} ${shorthand}`.slice(0, 4000)
    : formatTen8RadioComment(opts.callsign, opts.transcript);
  if (!note) {
    return { skipped: "empty_radio_comment" };
  }
  const res = await ten8AddComment(opts.agencyId, callId, note);
  return { call_id: callId, comment: note, ...res };
}

/**
 * Post plate/VIN decode to 10-8 vehicles API and duplicate the same facts as a CAD comment.
 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postTen8PlateLookupToCall(opts: {
  agencyId: number;
  callId: string;
  active: Ten8ActiveIncident[];
  callsign: string;
  lookup: PlateLookupResult;
  plateRequest: AiDispatchParseResult["plate_request"];
  trustedFromCreate: boolean;
}): Promise<Record<string, unknown>> {
  const callId = opts.callId.trim();
  if (!callId) {
    return { skipped: "empty_call_id" };
  }
  if (!opts.trustedFromCreate && !isVerifiedOpenCallId(callId, opts.active)) {
    console.warn(`[ten8] skip plate vehicle — call ${callId} not in open incident list`);
    return { skipped: "call_not_verified_open" };
  }

  const vehicleBody = buildTen8AddVehicleBodyCombined(opts.plateRequest, opts.lookup);
  const vehicleComment = formatTen8VehicleLookupComment(opts.callsign, opts.lookup);
  const retryDelays = opts.trustedFromCreate ? [0, 1500, 4000] : [0];

  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    const delay = retryDelays[attempt]!;
    if (delay > 0) {
      await sleepMs(delay);
    }
    const out: Record<string, unknown> = { call_id: callId, attempt: attempt + 1 };
    if (vehicleBody) {
      const vehicleRes = await ten8AddVehicle(
        opts.agencyId,
        callId,
        vehicleBody as unknown as Record<string, unknown>,
      );
      out.vehicle_request = vehicleBody;
      Object.assign(out, vehicleRes);
      if (vehicleRes.ok) {
        if (vehicleComment) {
          const commentRes = await ten8AddComment(opts.agencyId, callId, vehicleComment);
          out.vehicle_comment = { comment: vehicleComment, ...commentRes };
        }
        return out;
      }
      const status = vehicleRes.status ?? 0;
      if (opts.trustedFromCreate && (status === 404 || status === 0) && attempt < retryDelays.length - 1) {
        continue;
      }
    }

    if (vehicleComment) {
      const commentRes = await ten8AddComment(opts.agencyId, callId, vehicleComment);
      out.vehicle_comment = { comment: vehicleComment, ...commentRes };
    }

    if (!vehicleBody && !vehicleComment) {
      return { skipped: "no_vehicle_data", call_id: callId };
    }
    return out;
  }

  return { skipped: "vehicle_post_exhausted", call_id: callId };
}

async function persistAiDispatchLog(opts: {
  agencyId: number;
  transmissionId: number;
  channelName: string;
  unitId: string;
  transcript: string;
  parsed: AiDispatchParseResult | null;
  plateLookup: PlateLookupResult | null;
  ten8Actions: Record<string, unknown> | null;
  error: string | null;
  outcome: AiDispatchOutcome;
  durationMs: number;
}): Promise<void> {
  await insertAiDispatchLog({
    agencyId: opts.agencyId,
    transmissionId: opts.transmissionId,
    channelName: opts.channelName,
    unitId: opts.unitId,
    transcript: opts.transcript,
    parsed: opts.parsed,
    plateLookup: opts.plateLookup,
    ten8Actions: opts.ten8Actions,
    error: opts.error,
    outcome: opts.outcome,
    durationMs: opts.durationMs,
  }).catch((e) => console.warn("[ai-dispatch] log insert failed", e));
}

async function processTransmission(transmissionId: number): Promise<void> {
  const t0 = Date.now();
  let parsed: AiDispatchParseResult | null = null;
  let plateLookup: PlateLookupResult | null = null;
  let ten8Actions: Record<string, unknown> | null = null;
  let error: string | null = null;
  let transcript = "";
  let outcome: AiDispatchOutcome = "processed";
  let spokeOnAir = false;
  const ttsFailure: TtsFailureInfo = {};
  let tx: NonNullable<Awaited<ReturnType<typeof getTransmissionDispatchContext>>> | null = null;
  let unitId = "UNIT";
  let yieldsToUnits = true;
  let ten33Activated = false;

  try {
    tx = await getTransmissionDispatchContext(transmissionId);
    if (!tx) {
      return;
    }
    unitId = (tx.unit_id ?? "UNIT").trim().toUpperCase() || "UNIT";

    if (isAiDispatchUnit(tx.unit_id)) {
      outcome = "skipped_dispatch_unit";
      error = "Transmission from AI dispatch unit (not re-processed).";
      transcript = await loadTranscriptText(transmissionId) ?? "(AI dispatch unit)";
      return;
    }

    const channelRow = await getChannelAiDispatchRow(tx.agency_id, tx.channel_name);
    if (!channelRow?.enabled) {
      outcome = "skipped_channel_off";
      error = "AI dispatch is OFF for this channel.";
      transcript =
        (await loadTranscriptText(transmissionId)) ?? (await loadTranscriptRaw(transmissionId));
      return;
    }
    yieldsToUnits = channelRow.yields_to_units;

    const ageMs = Date.now() - new Date(tx.started_at).getTime();
    const allowOnAir = Number.isFinite(ageMs) ? ageMs <= MAX_ON_AIR_REPLY_AGE_MS : true;

    const text = await loadTranscriptText(transmissionId);
    if (!text) {
      outcome = "skipped_no_speech";
      transcript = await loadTranscriptRaw(transmissionId);
      error =
        transcript === "(transcript unavailable)"
          ? "Transcription failed (Whisper unavailable — often Railway out of memory). The AI never saw this transmission."
          : transcript === "(transcription disabled)"
            ? "Transcription is disabled (TRANSCRIPTION=off). The AI cannot read transmissions."
            : transcript === "(transcribing…)"
              ? "Transcript not ready yet (still transcribing)."
              : "No speech detected in recording.";
      return;
    }
    transcript = text;

    if (shouldSkipDuplicateAiDispatch(tx.agency_id, transcript)) {
      outcome = "skipped_duplicate";
      error = "Duplicate/simulcast copy of a recent transmission (skipped).";
      console.log(
        `[ai-dispatch] skip duplicate transcript agency=${tx.agency_id} channel=${tx.channel_name}`,
      );
      return;
    }

    const platform = getAiDispatchPlatformConfig();

    const emergencyRegex = detectEmergencyCodeFromTranscript(transcript);
    const officerDistress = detectOfficerDistressFromTranscript(transcript);
    const systemPrompt = await resolveAiDispatchSystemPrompt(tx.agency_id);
    const knowledgeContext = await retrieveKnowledge(tx.agency_id, transcript, {
      propertyCode: detectPropertyCode(transcript),
    });
    parsed = await parseDispatcherTransmission({
      systemPrompt,
      unitId,
      channelName: tx.channel_name,
      transcript,
      knowledgeContext,
    });

    let activeIncidents: Ten8ActiveIncident[] = [];
    if (parsed && (await ten8Configured(tx.agency_id))) {
      activeIncidents = await listTen8ActiveIncidents(tx.agency_id);
      parsed = applyOutWithCadRules(parsed, transcript, activeIncidents, unitId);
      parsed = applyCadDispatchRules(parsed, transcript);
      parsed = applyDistressDispatchRules(parsed, transcript);
    } else if (parsed) {
      parsed = applyDistressDispatchRules(parsed, transcript);
    }

    let distressTen33Callout: string | null = null;
    if (officerDistress) {
      distressTen33Callout = await buildDistressTen33Callout(
        tx.agency_id,
        parsed?.unit ?? unitId,
      );
    }

    if (allowOnAir && isEmergencyClear(emergencyRegex, parsed)) {
      await applyChannelTen33Marker({
        loopbackPort,
        agencyId: tx.agency_id,
        channelName: tx.channel_name,
        active: false,
        markerUnitId: platform.dispatchUnitId,
        source: emergencyRegex === "clear" ? "regex" : "ai",
      });
    } else if (allowOnAir && isEmergencyActivation(emergencyRegex, parsed, officerDistress)) {
      await applyChannelTen33Marker({
        loopbackPort,
        agencyId: tx.agency_id,
        channelName: tx.channel_name,
        active: true,
        markerUnitId: platform.dispatchUnitId,
        source: emergencyRegex === "activate" ? "regex" : "ai",
        startAudioLoop: false,
      });
      ten33Activated = true;
    }

    if (parsed) {
      const plate = await handlePlateFromParse({
        agencyId: tx.agency_id,
        unitId,
        parsed,
      });
      plateLookup = plate.lookup;

      ten8Actions = {};
      if (parsed.recommended_action) {
        ten8Actions.recommended_action = parsed.recommended_action;
      }
      if (plate.lookup) {
        ten8Actions.plate_lookup = plate.lookup;
      }

      if (await ten8Configured(tx.agency_id)) {
        const callsign = (parsed.unit ?? unitId ?? "").trim();
        let active = activeIncidents;
        const knownIncidentTypes = active
          .map((i) => i.incident_type)
          .filter((t): t is string => !!t?.trim());

        let newCallIdFromCreate: string | null = null;

        if (parsed.intent === "dispatch") {
          // Self-dispatch is a NEW call — create only; never comment on an unrelated open call.
          if (await ten8NewIncidentConfigured(tx.agency_id)) {
            const body = await buildTen8NewIncidentBody(
              tx.agency_id,
              parsed,
              callsign,
              platform.dispatchUnitId,
              { knownIncidentTypes, transcript },
            );
            const res = await ten8CreateIncident(tx.agency_id, body);
            ten8Actions.ten8_incident = { request: body, ...res };

            if (res.ok && !res.shadow) {
              const newCallId = extractCallIdFromCreateResponse(res.data);
              if (newCallId) {
                newCallIdFromCreate = newCallId;

                // Seed the local open-incident store with the call we just created so that
                // follow-up transmissions (plate runs, on-scene comments, "subject exiting
                // vehicle", etc.) can be linked even before 10-8's outbound webhook fires.
                // The webhook upsert is keyed on (agency_id, call_id) and will overwrite
                // this row when it arrives.
                try {
                  const seedIncidentType =
                    typeof body.type === "string" ? body.type : null;
                  const seedPriority =
                    typeof body.priority === "number"
                      ? String(body.priority)
                      : typeof body.priority === "string"
                        ? body.priority
                        : null;
                  const seedLocation =
                    typeof body.location === "string" ? body.location : null;
                  await upsertTen8Incident({
                    agencyId: tx.agency_id,
                    callId: newCallId,
                    action: "created",
                    isClosed: false,
                    incidentType: seedIncidentType,
                    priority: seedPriority,
                    status: "active",
                    location: seedLocation,
                    payload: {
                      action: "created",
                      seeded_by: "ai_dispatch_create",
                      incident: {
                        callID: newCallId,
                        type: seedIncidentType,
                        isClosed: 0,
                        status: "active",
                        units: callsign ? [{ unit: callsign }] : [],
                        location: seedLocation,
                        ...buildTen8IncidentSeedCoords(body),
                        ...(seedPriority ? { priority: seedPriority } : {}),
                      },
                    },
                  });
                  // Refresh the in-memory active list so the rest of this transmission
                  // (plate vehicle linkage below) and any queued follow-ups can see it.
                  activeIncidents = await listTen8ActiveIncidents(tx.agency_id);
                  active = activeIncidents;
                } catch (e) {
                  console.warn("[ai-dispatch] failed to seed ten8_incidents after create", e);
                }

                const note = formatTen8RadioComment(callsign, transcript);
                if (note) {
                  const commentRes = await ten8AddComment(tx.agency_id, newCallId, note);
                  ten8Actions.ten8_incident_comment = {
                    call_id: newCallId,
                    comment: note,
                    ...commentRes,
                  };
                }
              }
            }
          } else {
            ten8Actions.ten8_incident = { skipped: "new_incident_not_configured" };
          }
        } else if (parsed.actionable) {
          if (active.length === 0) {
            ten8Actions.ten8_comment = { skipped: "no_open_calls" };
          } else {
            const match = findMatchingOpenIncident(active, parsed, unitId);
            if (!match?.call_id?.trim()) {
              ten8Actions.ten8_comment = { skipped: "no_matching_open_call" };
            } else {
              ten8Actions.ten8_comment = await postTen8RadioCommentIfVerified({
                agencyId: tx.agency_id,
                callId: match.call_id,
                active,
                callsign,
                transcript,
                commentText: parsed.comment_text,
              });
            }
          }
        }

        if (
          plate.lookup &&
          (plate.lookup.plate || plate.lookup.vin || parsed.plate_request?.plate || parsed.plate_request?.vin)
        ) {
          let plateCallId = newCallIdFromCreate;
          const trustedFromCreate = !!plateCallId;
          if (!plateCallId) {
            const match = findMatchingOpenIncident(active, parsed, unitId);
            plateCallId = match?.call_id?.trim() || null;
          }
          if (plateCallId) {
            ten8Actions.ten8_plate_vehicle = await postTen8PlateLookupToCall({
              agencyId: tx.agency_id,
              callId: plateCallId,
              active,
              callsign,
              lookup: plate.lookup,
              plateRequest: parsed.plate_request,
              trustedFromCreate,
            });
          } else {
            ten8Actions.ten8_plate_vehicle = { skipped: "no_matching_open_call_for_plate" };
          }
        }

        if (parsed.cad_person_link || parsed.cad_tag || parsed.cad_tag_remove) {
          const linkMatch = findMatchingOpenIncident(active, parsed, unitId);
          const linkCallId = linkMatch?.call_id?.trim() || newCallIdFromCreate;
          if (!linkCallId || !isVerifiedOpenCallId(linkCallId, active)) {
            ten8Actions.ten8_cad_link = { skipped: "no_verified_open_call_for_cad_link" };
          } else {
            if (parsed.cad_person_link) {
              const body = buildCadPersonLinkBody(parsed.cad_person_link);
              const res = await ten8AddPerson(tx.agency_id, linkCallId, body);
              ten8Actions.ten8_person = { call_id: linkCallId, request: body, ...res };
            }
            if (parsed.cad_tag) {
              const res = await ten8AddTag(tx.agency_id, linkCallId, { tag: parsed.cad_tag });
              ten8Actions.ten8_tag = { call_id: linkCallId, tag: parsed.cad_tag, ...res };
            }
            if (parsed.cad_tag_remove) {
              const out: Record<string, unknown> = {
                call_id: linkCallId,
                tag: parsed.cad_tag_remove,
              };
              const got = await ten8GetIncident(tx.agency_id, linkCallId);
              if (got.ok && got.data && typeof got.data === "object") {
                const tagId = findTagIdOnIncident(
                  got.data as Record<string, unknown>,
                  parsed.cad_tag_remove,
                );
                if (tagId != null) {
                  const res = await ten8RemoveTag(tx.agency_id, linkCallId, tagId);
                  Object.assign(out, res);
                } else {
                  out.skipped = "tag_not_on_call";
                }
              } else {
                out.skipped = "incident_fetch_failed";
              }
              ten8Actions.ten8_tag_remove = out;
            }
          }
        }
      }

      let speakText = plate.speakText || parsed.dispatcher_response?.trim() || "";
      let ttsKind: TtsSpeechKind = plate.speakText ? "plate_readback" : "auto";

      if (parsed.intent === "request_info" && parsed.info_request) {
        if (infoRequestNeedsAsync(parsed.info_request)) {
          speakText = buildInfoRequestAck(parsed.unit ?? unitId);
          ttsKind = "radio_ack";
          const reply = adaptDispatcherResponseForChannel(speakText, tx.channel_name);
          parsed = { ...parsed, dispatcher_response: reply };
          if (allowOnAir) {
            spokeOnAir = await speakDispatcherReply(
              tx,
              transmissionId,
              unitId,
              transcript,
              reply,
              yieldsToUnits,
              ttsKind,
              ttsFailure,
            );
            void runAsyncInfoLookup(tx, transmissionId, unitId, transcript, parsed, yieldsToUnits);
          }
        } else {
          const answer = await buildInfoRequestResponse(
            tx.agency_id,
            parsed.info_request,
            parsed.unit ?? unitId,
          );
          if (answer) {
            speakText = answer;
            ttsKind = "info_lookup";
          }
        }
      } else if (!plate.speakText) {
        // Don't override an explicit plate readback ("...comes back to a 2018 Honda Civic")
        // with the generic deterministic dispatch ack ("Copy 352, 961 at 18-06") — the
        // readback is the useful response for the officer.
        const detAck = buildDeterministicDispatchAck(parsed, parsed.unit ?? unitId);
        if (detAck) {
          speakText = detAck;
        }
      }

      if (!speakText) {
        speakText =
          fallbackReplyForSilentParse(parsed.unit ?? unitId, transcript, parsed) ?? "";
      }

      if (ten33Activated && officerDistress && distressTen33Callout) {
        speakText = distressTen33Callout;
        ttsKind = "emergency";
      } else if (!speakText && ten33Activated) {
        speakText = defaultTen33Callout(tx.channel_name);
        ttsKind = "emergency";
      }

      if (allowOnAir && speakText && parsed.intent !== "request_info") {
        const reply = adaptDispatcherResponseForChannel(speakText, tx.channel_name);
        parsed = { ...parsed, dispatcher_response: reply };
        spokeOnAir = await speakDispatcherReply(
          tx,
          transmissionId,
          unitId,
          transcript,
          reply,
          yieldsToUnits,
          ttsKind,
          ttsFailure,
        );
        if (plate.followUpSpeak?.trim()) {
          const tail = adaptDispatcherResponseForChannel(plate.followUpSpeak.trim(), tx.channel_name);
          await speakDispatcherReply(
            tx,
            transmissionId,
            unitId,
            transcript,
            tail,
            yieldsToUnits,
            "plate_readback",
          );
        }
      } else if (allowOnAir && speakText && parsed.intent === "request_info" && !infoRequestNeedsAsync(parsed.info_request!)) {
        const reply = adaptDispatcherResponseForChannel(speakText, tx.channel_name);
        parsed = { ...parsed, dispatcher_response: reply };
        spokeOnAir = await speakDispatcherReply(
          tx,
          transmissionId,
          unitId,
          transcript,
          reply,
          yieldsToUnits,
          ttsKind,
          ttsFailure,
        );
      }

      if (outcome === "processed") {
        if (!speakText) {
          outcome = "no_on_air_reply";
          console.log(
            `[ai-dispatch] no on-air reply: intent=${parsed.intent} dispatcher_response=${parsed.dispatcher_response ? "present" : "null"} channel=${tx.channel_name}`,
          );
          error =
            "AI processed this but had nothing to say on the radio (often chitchat with no dispatcher_response).";
        } else if (!allowOnAir) {
          outcome = "skipped_stale";
          console.log(
            `[ai-dispatch] stale transmission (age ${Math.round(ageMs / 1000)}s) — logged only, not aired, channel=${tx.channel_name}`,
          );
          error = "Logged only — transmission too old to air a reply (backfill / catch-up after a restart).";
        } else if (!spokeOnAir) {
          outcome = "tts_failed";
          error =
            error ??
            (ttsFailure.detail
              ? `Reply not aired — ${ttsFailure.detail}`
              : "TTS or on-channel playback failed. Check ElevenLabs API key and voice ID under Admin → Integrations.");
        }
      }

      if (ten33Activated) {
        startTen33MarkerLoop(
          {
            loopbackPort,
            agencyId: tx.agency_id,
            channelName: tx.channel_name,
            unitId: platform.dispatchUnitId,
          },
          true,
        );
      }
    } else {
      error = "AI parse failed";
      if (allowOnAir && (emergencyRegex === "activate" || officerDistress)) {
        await applyChannelTen33Marker({
          loopbackPort,
          agencyId: tx.agency_id,
          channelName: tx.channel_name,
          active: true,
          markerUnitId: platform.dispatchUnitId,
          source: officerDistress ? "regex" : "regex",
          startAudioLoop: false,
        });
        ten33Activated = true;
        const callout =
          officerDistress && distressTen33Callout
            ? distressTen33Callout
            : defaultTen33Callout(tx.channel_name);
        const reply = adaptDispatcherResponseForChannel(callout, tx.channel_name);
        spokeOnAir = await speakDispatcherReply(
          tx,
          transmissionId,
          unitId,
          transcript,
          reply,
          yieldsToUnits,
          "emergency",
        );
        startTen33MarkerLoop(
          {
            loopbackPort,
            agencyId: tx.agency_id,
            channelName: tx.channel_name,
            unitId: platform.dispatchUnitId,
          },
          true,
        );
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.warn(`[ai-dispatch] failed for transmission ${transmissionId}`, err);
    if (tx && ten33Activated) {
      stopTen33MarkerLoop(tx.agency_id, tx.channel_name);
    }
  } finally {
    if (tx && transcript) {
      await persistAiDispatchLog({
        agencyId: tx.agency_id,
        transmissionId,
        channelName: tx.channel_name,
        unitId,
        transcript,
        parsed,
        plateLookup,
        ten8Actions,
        error,
        outcome,
        durationMs: Date.now() - t0,
      });
    }
  }
}

async function runAsyncInfoLookup(
  tx: NonNullable<Awaited<ReturnType<typeof getTransmissionDispatchContext>>>,
  transmissionId: number,
  unitId: string,
  transcript: string,
  parsed: AiDispatchParseResult,
  yieldsToUnits: boolean,
): Promise<void> {
  if (!parsed.info_request) {
    return;
  }
  try {
    let answer = await buildInfoRequestResponse(
      tx.agency_id,
      parsed.info_request,
      parsed.unit ?? unitId,
    );
    let followUpTen8: Record<string, unknown> | null = null;

    if (
      parsed.info_request.type === "cad_person_search" &&
      parsed.info_request.subject?.trim() &&
      (await ten8Configured(tx.agency_id)) &&
      personSearchHadNoMatch(answer ?? "")
    ) {
      const active = await listTen8ActiveIncidents(tx.agency_id);
      const match = findMatchingOpenIncident(active, parsed, unitId);
      const link =
        parsed.cad_person_link ??
        buildCadPersonLinkFromSubject(parsed.info_request.subject);
      const callId = match?.call_id?.trim();
      if (callId && link && isVerifiedOpenCallId(callId, active)) {
        followUpTen8 = await createPersonOnCallAfterMiss({
          agencyId: tx.agency_id,
          callId,
          callsign: (parsed.unit ?? unitId).trim(),
          subject: parsed.info_request.subject.trim(),
          link,
        });
        answer = `${answer ?? ""} Created a new person on your call and logged it.`;
      }
    }

    const reply = adaptDispatcherResponseForChannel(
      answer || genericInfoLookupFailedLine(callsignPrefixForRadio(parsed.unit ?? unitId)),
      tx.channel_name,
    );
    await speakDispatcherReply(tx, transmissionId, unitId, transcript, reply, yieldsToUnits, "info_lookup");
    // follow-up log entry (separate from parent transmission)
    await persistAiDispatchLog({
      agencyId: tx.agency_id,
      transmissionId,
      channelName: tx.channel_name,
      unitId: parsed.unit ?? unitId,
      transcript: `[Follow-up] ${parsed.info_request.type}: ${parsed.info_request.subject ?? ""}`.trim(),
      parsed: {
        actionable: true,
        intent: "request_info",
        unit: parsed.unit ?? unitId,
        summary: `Async answer: ${reply.slice(0, 200)}`,
        confidence: 1,
        dispatcher_response: reply,
        trigger_emergency_tone: false,
        recommended_action: null,
        plate_request: null,
        code: null,
        location_code: null,
        location_name: null,
        info_request: parsed.info_request,
        comment_text: null,
        cad_person_link: null,
        cad_tag: null,
        cad_tag_remove: null,
      },
      plateLookup: null,
      ten8Actions: followUpTen8,
      error: null,
      outcome: "followup_info",
      durationMs: 0,
    });
    console.log(`[ai-dispatch] info_request async answer agency=${tx.agency_id} type=${parsed.info_request.type}`);
  } catch (err) {
    console.warn("[ai-dispatch] async info_request failed", err);
    const fallback = adaptDispatcherResponseForChannel(
      genericInfoLookupFailedLine(callsignPrefixForRadio(parsed.unit ?? unitId)),
      tx.channel_name,
    );
    await speakDispatcherReply(tx, transmissionId, unitId, transcript, fallback, yieldsToUnits, "info_lookup").catch(
      () => undefined,
    );
  }
}

async function speakDispatcherReply(
  tx: NonNullable<Awaited<ReturnType<typeof getTransmissionDispatchContext>>>,
  transmissionId: number,
  unitId: string,
  transcript: string,
  reply: string,
  yieldsToUnits: boolean,
  speechKind: TtsSpeechKind = "auto",
  failureSink?: TtsFailureInfo,
): Promise<boolean> {
  const failure: TtsFailureInfo = failureSink ?? {};
  const mp3 = await synthesizeElevenLabsMp3(tx.agency_id, reply, { speechKind, failure });
  if (!mp3) {
    console.warn(
      `[ai-dispatch] ElevenLabs returned no audio agency=${tx.agency_id} channel=${tx.channel_name}: ${failure.detail ?? "unknown reason"}`,
    );
    return false;
  }

  const platform = getAiDispatchPlatformConfig();
  const tmpPath = join(tmpdir(), `ai-dispatch-${randomBytes(8).toString("hex")}.mp3`);
  await writeFile(tmpPath, mp3);
  try {
    await playMp3UrlOnChannel({
      loopbackPort,
      agencyId: tx.agency_id,
      channelName: tx.channel_name,
      unitId: platform.dispatchUnitId,
      yieldsToUnits,
      mp3Url: tmpPath,
    });
  } catch (playErr) {
    console.warn(`[ai-dispatch] playback failed channel=${tx.channel_name}`, playErr);
    failure.detail = `On-channel playback failed: ${playErr instanceof Error ? playErr.message : String(playErr)}`;
    return false;
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }

  void postOutboundWebhook(tx.agency_id, {
    type: "ai_dispatch_reply",
    transmission_id: transmissionId,
    channel: tx.channel_name,
    unit_id: unitId,
    transcript_in: transcript,
    reply_text: reply,
  });

  console.log(
    `[ai-dispatch] agency=${tx.agency_id} channel=${tx.channel_name} unit=${unitId} reply="${reply.slice(0, 80)}"`,
  );
  return true;
}

async function loadTranscriptRaw(transmissionId: number): Promise<string> {
  const { getPool } = await import("../db.js");
  const pool = getPool();
  if (!pool) {
    return "(database unavailable)";
  }
  const res = await pool.query<{ transcript: string | null; transcript_status: string }>(
    `SELECT transcript, transcript_status FROM transmissions WHERE id = $1;`,
    [transmissionId],
  );
  const row = res.rows[0];
  if (!row) {
    return "(transmission not found)";
  }
  if (row.transcript_status === "pending") {
    return "(transcribing…)";
  }
  if (row.transcript_status === "failed") {
    return "(transcript unavailable)";
  }
  if (row.transcript_status === "disabled") {
    return "(transcription disabled)";
  }
  const text = row.transcript?.trim() ?? "";
  return text.length > 0 ? text : "(no speech detected)";
}

async function loadTranscriptText(transmissionId: number): Promise<string | null> {
  const { getPool } = await import("../db.js");
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const res = await pool.query<{ transcript: string | null; transcript_status: string }>(
    `SELECT transcript, transcript_status FROM transmissions WHERE id = $1;`,
    [transmissionId],
  );
  const row = res.rows[0];
  if (!row || row.transcript_status !== "done") {
    return null;
  }
  const text = row.transcript?.trim() ?? "";
  return text.length > 0 ? text : null;
}
