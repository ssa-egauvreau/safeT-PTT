import { getChannelAiDispatchRow } from "../store.js";
import { adaptDispatcherResponseForChannel, detectEmergencyCodeFromTranscript } from "./emergencyCodes.js";
import { handlePlateFromParse } from "./plateHandler.js";
import { parseDispatcherTransmission, type AiDispatchParseResult } from "./parse.js";
import {
  getAiDispatchPlatformConfig,
  resolveAiDispatchSystemPrompt,
} from "./platformConfig.js";
import { buildDeterministicDispatchAck } from "./dispatchAck.js";
import { applyOutWithCadRules } from "./outWithCad.js";
import {
  buildInfoRequestAck,
  buildInfoRequestResponse,
  incidentPayloadHasUnit,
  infoRequestNeedsAsync,
} from "./infoRequest.js";
import { synthesizeElevenLabsMp3, type TtsSpeechKind } from "./tts.js";
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
  ten8NewIncidentConfigured,
} from "../ten8/client.js";
import { buildCadPersonLinkBody } from "../ten8/cadRadioLookup.js";
import { buildTen8NewIncidentBody } from "../ten8/incidentPayload.js";
import {
  extractCallIdFromCreateResponse,
  formatTen8RadioComment,
  isVerifiedOpenCallId,
} from "../ten8/cadComments.js";
import {
  buildTen8AddVehicleBody,
  formatTen8VehicleLookupComment,
} from "../ten8/vehicles.js";
import type { PlateLookupResult } from "./plateLookup.js";

export interface AiDispatchDryRunRequest {
  agencyId: number;
  transcript: string;
  channelName: string;
  unitId: string;
  /** When true, actually POSTs to 10-8 (create incident, add comments/vehicles). Default false. */
  sendForReal?: boolean;
  /** When true, synthesizes the dispatcher reply MP3 for browser preview. Default true. */
  synthesizeTts?: boolean;
}

export interface AiDispatchDryRunTraceEntry {
  phase: string;
  ms: number;
  detail?: string;
}

export interface AiDispatchDryRunResult {
  request: {
    transcript: string;
    channelName: string;
    unitId: string;
    sendForReal: boolean;
    synthesizeTts: boolean;
  };
  durationMs: number;
  trace: AiDispatchDryRunTraceEntry[];
  channelAiDispatchEnabled: boolean;
  ten8Configured: boolean;
  parsed: AiDispatchParseResult | null;
  knowledgeContextChars: number;
  knowledgeContextPreview: string;
  plateLookup: PlateLookupResult | null;
  ten8Actions: Record<string, unknown>;
  dispatcherReply: string;
  ttsKind: TtsSpeechKind;
  ttsMp3Base64: string | null;
  errors: string[];
}

function defaultTen33Callout(channelName: string): string {
  return `All units 10-33 on ${channelName}, all units 10-33 on ${channelName}.`;
}

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

function findMatchingOpenIncident<I extends { call_id: string; payload: unknown; location: string | null }>(
  active: I[],
  parsed: AiDispatchParseResult,
  fallbackUnit: string,
): I | null {
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

/**
 * Typed-text "what would the AI dispatcher do" — runs the same primitives as
 * processTransmission() (parse, knowledge base retrieval, plate lookup, 10-8
 * body building, deterministic acks, TTS) but never broadcasts on the radio
 * channel and skips 10-8 writes unless `sendForReal=true`. Used by the admin
 * AI test page.
 */
export async function runAiDispatchDryRun(
  opts: AiDispatchDryRunRequest,
): Promise<AiDispatchDryRunResult> {
  const t0 = Date.now();
  const trace: AiDispatchDryRunTraceEntry[] = [];
  const errors: string[] = [];
  const sendForReal = opts.sendForReal === true;
  const synthesizeTts = opts.synthesizeTts !== false;
  const ten8Actions: Record<string, unknown> = {};

  const unitId = (opts.unitId ?? "UNIT").trim().toUpperCase() || "UNIT";
  const channelName = opts.channelName.trim() || "test-channel";
  const transcript = opts.transcript.trim();

  const result: AiDispatchDryRunResult = {
    request: {
      transcript,
      channelName,
      unitId,
      sendForReal,
      synthesizeTts,
    },
    durationMs: 0,
    trace,
    channelAiDispatchEnabled: false,
    ten8Configured: false,
    parsed: null,
    knowledgeContextChars: 0,
    knowledgeContextPreview: "",
    plateLookup: null,
    ten8Actions,
    dispatcherReply: "",
    ttsKind: "auto",
    ttsMp3Base64: null,
    errors,
  };

  if (!transcript) {
    errors.push("Transcript is empty.");
    result.durationMs = Date.now() - t0;
    return result;
  }

  const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      trace.push({ phase: name, ms: Date.now() - start });
    }
  };

  try {
    const channelRow = await phase("channel_ai_status", () =>
      getChannelAiDispatchRow(opts.agencyId, channelName),
    );
    result.channelAiDispatchEnabled = channelRow?.enabled === true;

    const platform = getAiDispatchPlatformConfig();
    if (!platform.enabled) {
      errors.push("AI dispatch platform is OFF for this server (AI_DISPATCH_ENABLED).");
    }

    const systemPrompt = await phase("system_prompt", () =>
      resolveAiDispatchSystemPrompt(opts.agencyId),
    );

    const knowledgeContext = await phase("knowledge_base", () =>
      retrieveKnowledge(opts.agencyId, transcript, {
        propertyCode: detectPropertyCode(transcript),
      }),
    );
    result.knowledgeContextChars = knowledgeContext.length;
    result.knowledgeContextPreview = knowledgeContext.slice(0, 4000);

    let parsed: AiDispatchParseResult | null = await phase("parse_llm", () =>
      parseDispatcherTransmission({
        systemPrompt,
        unitId,
        channelName,
        transcript,
        knowledgeContext,
      }),
    );
    result.parsed = parsed;

    if (!parsed) {
      errors.push("LLM parse failed — model returned no JSON. Check AI_DISPATCH_LLM_API_KEY / model.");
      result.durationMs = Date.now() - t0;
      return result;
    }

    result.ten8Configured = await phase("ten8_configured", () => ten8Configured(opts.agencyId));

    let activeIncidents: Awaited<ReturnType<typeof listTen8ActiveIncidents>> = [];
    if (result.ten8Configured) {
      activeIncidents = await phase("ten8_list_active", () =>
        listTen8ActiveIncidents(opts.agencyId),
      );
      parsed = applyOutWithCadRules(parsed, transcript, activeIncidents, unitId);
      result.parsed = parsed;
    }

    const emergencyRegex = detectEmergencyCodeFromTranscript(transcript);
    const ten33Activated =
      emergencyRegex === "activate" ||
      parsed.trigger_emergency_tone === true ||
      parsed.intent === "emergency";

    const plate = await phase("plate_lookup", () =>
      handlePlateFromParse({ agencyId: opts.agencyId, unitId, parsed: parsed! }),
    );
    result.plateLookup = plate.lookup;
    if (parsed.recommended_action) {
      ten8Actions.recommended_action = parsed.recommended_action;
    }
    if (plate.lookup) {
      ten8Actions.plate_lookup = plate.lookup;
    }

    let newCallIdFromCreate: string | null = null;
    const callsign = (parsed.unit ?? unitId ?? "").trim();
    let active = activeIncidents;

    if (result.ten8Configured) {
      const knownIncidentTypes = active
        .map((i) => i.incident_type)
        .filter((t): t is string => !!t?.trim());

      if (parsed.intent === "dispatch") {
        if (await ten8NewIncidentConfigured(opts.agencyId)) {
          const body = await phase("ten8_build_new_incident", () =>
            buildTen8NewIncidentBody(
              opts.agencyId,
              parsed!,
              callsign,
              platform.dispatchUnitId,
              { knownIncidentTypes, transcript },
            ),
          );
          if (sendForReal) {
            const res = await phase("ten8_create_incident", () =>
              ten8CreateIncident(opts.agencyId, body),
            );
            ten8Actions.ten8_incident = { request: body, would_post: true, ...res };
            if (res.ok && !res.shadow) {
              const newCallId = extractCallIdFromCreateResponse(res.data);
              if (newCallId) {
                newCallIdFromCreate = newCallId;
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
                    agencyId: opts.agencyId,
                    callId: newCallId,
                    action: "created",
                    isClosed: false,
                    incidentType: seedIncidentType,
                    priority: seedPriority,
                    status: "active",
                    location: seedLocation,
                    payload: {
                      action: "created",
                      seeded_by: "ai_dispatch_test_page",
                      incident: {
                        callID: newCallId,
                        type: seedIncidentType,
                        isClosed: 0,
                        status: "active",
                        units: callsign ? [{ unit: callsign }] : [],
                        location: seedLocation,
                        ...(seedPriority ? { priority: seedPriority } : {}),
                      },
                    },
                  });
                  active = await listTen8ActiveIncidents(opts.agencyId);
                } catch (e) {
                  errors.push(`Seed ten8_incidents failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                const note = formatTen8RadioComment(callsign, transcript);
                if (note) {
                  const commentRes = await ten8AddComment(opts.agencyId, newCallId, note);
                  ten8Actions.ten8_incident_comment = {
                    call_id: newCallId,
                    comment: note,
                    would_post: true,
                    ...commentRes,
                  };
                }
              }
            }
          } else {
            ten8Actions.ten8_incident = {
              request: body,
              would_post: false,
              note: "DRY RUN — body built but not posted to 10-8.",
            };
            const note = formatTen8RadioComment(callsign, transcript);
            if (note) {
              ten8Actions.ten8_incident_comment = {
                call_id: "(new, not yet created)",
                comment: note,
                would_post: false,
              };
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
            const shorthand = parsed.comment_text?.trim();
            const text = shorthand
              ? `${callsign.trim()} ${shorthand}`.slice(0, 4000)
              : formatTen8RadioComment(callsign, transcript);
            if (sendForReal) {
              if (text && isVerifiedOpenCallId(match.call_id, active)) {
                const commentRes = await ten8AddComment(opts.agencyId, match.call_id, text);
                ten8Actions.ten8_comment = {
                  call_id: match.call_id,
                  comment: text,
                  would_post: true,
                  ...commentRes,
                };
              } else {
                ten8Actions.ten8_comment = {
                  call_id: match.call_id,
                  skipped: "empty_or_unverified",
                  would_post: false,
                };
              }
            } else {
              ten8Actions.ten8_comment = {
                call_id: match.call_id,
                comment: text,
                would_post: false,
                note: "DRY RUN — comment would be posted on the matched open call.",
              };
            }
          }
        }
      }

      if (plate.lookup && (plate.lookup.plate || plate.lookup.vin)) {
        let plateCallId = newCallIdFromCreate;
        const trustedFromCreate = !!plateCallId;
        if (!plateCallId) {
          const match = findMatchingOpenIncident(active, parsed, unitId);
          plateCallId = match?.call_id?.trim() || null;
        }
        const vehicleBody = buildTen8AddVehicleBody(plate.lookup);
        const vehicleComment = formatTen8VehicleLookupComment(callsign, plate.lookup);
        if (!plateCallId) {
          ten8Actions.ten8_plate_vehicle = { skipped: "no_matching_open_call_for_plate" };
        } else if (sendForReal) {
          const out: Record<string, unknown> = { call_id: plateCallId, would_post: true };
          if (trustedFromCreate || isVerifiedOpenCallId(plateCallId, active)) {
            if (vehicleBody) {
              const vRes = await ten8AddVehicle(
                opts.agencyId,
                plateCallId,
                vehicleBody as unknown as Record<string, unknown>,
              );
              out.vehicle_request = vehicleBody;
              Object.assign(out, vRes);
            }
            if (vehicleComment) {
              const cRes = await ten8AddComment(opts.agencyId, plateCallId, vehicleComment);
              out.vehicle_comment = { comment: vehicleComment, ...cRes };
            }
          } else {
            out.skipped = "call_not_verified_open";
          }
          ten8Actions.ten8_plate_vehicle = out;
        } else {
          ten8Actions.ten8_plate_vehicle = {
            call_id: plateCallId,
            would_post: false,
            vehicle_request: vehicleBody,
            vehicle_comment: vehicleComment,
            trustedFromCreate,
            note: "DRY RUN — vehicle + comment would be added to this call.",
          };
        }
      }

      if (parsed.cad_person_link || parsed.cad_tag) {
        const linkMatch = findMatchingOpenIncident(active, parsed, unitId);
        const linkCallId = linkMatch?.call_id?.trim() || newCallIdFromCreate;
        if (!linkCallId || !isVerifiedOpenCallId(linkCallId, active)) {
          ten8Actions.ten8_cad_link = { skipped: "no_verified_open_call_for_cad_link" };
        } else if (parsed.cad_person_link) {
          const body = buildCadPersonLinkBody(parsed.cad_person_link);
          if (sendForReal) {
            const res = await ten8AddPerson(opts.agencyId, linkCallId, body);
            ten8Actions.ten8_person = { call_id: linkCallId, request: body, would_post: true, ...res };
          } else {
            ten8Actions.ten8_person = {
              call_id: linkCallId,
              request: body,
              would_post: false,
              note: "DRY RUN — person would be linked on this call.",
            };
          }
        }
        if (parsed.cad_tag && linkCallId && isVerifiedOpenCallId(linkCallId, active)) {
          if (sendForReal) {
            const res = await ten8AddTag(opts.agencyId, linkCallId, { tag: parsed.cad_tag });
            ten8Actions.ten8_tag = { call_id: linkCallId, tag: parsed.cad_tag, would_post: true, ...res };
          } else {
            ten8Actions.ten8_tag = {
              call_id: linkCallId,
              tag: parsed.cad_tag,
              would_post: false,
              note: "DRY RUN — tag would be added on this call.",
            };
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
        try {
          const asyncAnswer = await phase("info_request_async_lookup", () =>
            buildInfoRequestResponse(opts.agencyId, parsed!.info_request!, parsed!.unit ?? unitId),
          );
          if (asyncAnswer) {
            ten8Actions.info_request_async_followup = {
              note: "Async lookup completed — on a live transmission this would be spoken as a follow-up.",
              answer: asyncAnswer,
            };
          }
        } catch (e) {
          errors.push(`info_request async lookup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        const answer = await phase("info_request_sync_lookup", () =>
          buildInfoRequestResponse(opts.agencyId, parsed!.info_request!, parsed!.unit ?? unitId),
        );
        if (answer) {
          speakText = answer;
          ttsKind = "info_lookup";
        }
      }
    } else if (!plate.speakText) {
      const detAck = buildDeterministicDispatchAck(parsed, parsed.unit ?? unitId);
      if (detAck) {
        speakText = detAck;
      }
    }

    if (!speakText && ten33Activated) {
      speakText = defaultTen33Callout(channelName);
      ttsKind = "emergency";
    }

    const reply = speakText ? adaptDispatcherResponseForChannel(speakText, channelName) : "";
    result.dispatcherReply = reply;
    result.ttsKind = ttsKind;

    if (synthesizeTts && reply) {
      const mp3 = await phase("tts_synthesize", () =>
        synthesizeElevenLabsMp3(opts.agencyId, reply, { speechKind: ttsKind }),
      );
      if (mp3) {
        result.ttsMp3Base64 = mp3.toString("base64");
      } else {
        errors.push("ElevenLabs returned no audio (check ElevenLabs API key + voice ID in Integrations).");
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    console.warn("[ai-dispatch] dry-run failed", e);
  } finally {
    result.durationMs = Date.now() - t0;
  }

  return result;
}
