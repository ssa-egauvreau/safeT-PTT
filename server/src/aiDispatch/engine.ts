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
import { handlePlateFromParse } from "./plateHandler.js";
import { parseDispatcherTransmission } from "./parse.js";
import {
  getAiDispatchPlatformConfig,
  isAiDispatchUnit,
  resolveAiDispatchSystemPrompt,
} from "./platformConfig.js";
import { playMp3UrlOnChannel } from "./playback.js";
import { buildDeterministicDispatchAck } from "./dispatchAck.js";
import {
  buildInfoRequestAck,
  buildInfoRequestResponse,
  infoRequestNeedsAsync,
} from "./infoRequest.js";
import { synthesizeElevenLabsMp3 } from "./tts.js";
import { postOutboundWebhook } from "./webhook.js";
import {
  applyChannelTen33Marker,
  startTen33MarkerLoop,
  stopTen33MarkerLoop,
} from "./ten33Marker.js";
import { shouldSkipDuplicateAiDispatch } from "./dedupe.js";
import { listTen8ActiveIncidents } from "../ten8/store.js";
import { ten8AddComment, ten8Configured } from "../ten8/client.js";
import type { PlateLookupResult } from "./plateLookup.js";
import type { AiDispatchParseResult } from "./parse.js";

const queue: number[] = [];
let working = false;
let loopbackPort = 8080;

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
): boolean {
  return (
    emergencyRegex === "activate" ||
    parsed?.trigger_emergency_tone === true ||
    parsed?.intent === "emergency"
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
    const systemPrompt = await resolveAiDispatchSystemPrompt(tx.agency_id);
    parsed = await parseDispatcherTransmission({
      systemPrompt,
      unitId,
      channelName: tx.channel_name,
      transcript,
    });

    if (isEmergencyClear(emergencyRegex, parsed)) {
      await applyChannelTen33Marker({
        loopbackPort,
        agencyId: tx.agency_id,
        channelName: tx.channel_name,
        active: false,
        markerUnitId: platform.dispatchUnitId,
        source: emergencyRegex === "clear" ? "regex" : "ai",
      });
    } else if (isEmergencyActivation(emergencyRegex, parsed)) {
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
        const cadNote = `[AI] ${parsed.summary}`.slice(0, 500);
        const active = await listTen8ActiveIncidents(tx.agency_id);
        if (active.length > 0 && parsed.actionable) {
          const target = active[0]!.call_id;
          const res = await ten8AddComment(tx.agency_id, target, cadNote);
          ten8Actions.ten8_comment = { call_id: target, ...res };
        } else {
          ten8Actions.ten8_comment = { skipped: "no_active_incident" };
        }
      }

      let speakText = plate.speakText || parsed.dispatcher_response?.trim() || "";

      if (parsed.intent === "request_info" && parsed.info_request) {
        if (infoRequestNeedsAsync(parsed.info_request)) {
          speakText = buildInfoRequestAck(parsed.unit ?? unitId);
          const reply = adaptDispatcherResponseForChannel(speakText, tx.channel_name);
          parsed = { ...parsed, dispatcher_response: reply };
          spokeOnAir = await speakDispatcherReply(tx, transmissionId, unitId, transcript, reply, yieldsToUnits);
          void runAsyncInfoLookup(tx, transmissionId, unitId, transcript, parsed, yieldsToUnits);
        } else {
          const answer = await buildInfoRequestResponse(
            tx.agency_id,
            parsed.info_request,
            parsed.unit ?? unitId,
          );
          if (answer) {
            speakText = answer;
          }
        }
      } else {
        const detAck = buildDeterministicDispatchAck(parsed, parsed.unit ?? unitId);
        if (detAck) {
          speakText = detAck;
        }
      }

      if (!speakText) {
        speakText =
          fallbackReplyForSilentParse(parsed.unit ?? unitId, transcript, parsed) ?? "";
      }

      if (!speakText && ten33Activated) {
        speakText = defaultTen33Callout(tx.channel_name);
      }

      if (speakText && parsed.intent !== "request_info") {
        const reply = adaptDispatcherResponseForChannel(speakText, tx.channel_name);
        parsed = { ...parsed, dispatcher_response: reply };
        spokeOnAir = await speakDispatcherReply(tx, transmissionId, unitId, transcript, reply, yieldsToUnits);
      } else if (speakText && parsed.intent === "request_info" && !infoRequestNeedsAsync(parsed.info_request!)) {
        const reply = adaptDispatcherResponseForChannel(speakText, tx.channel_name);
        parsed = { ...parsed, dispatcher_response: reply };
        spokeOnAir = await speakDispatcherReply(tx, transmissionId, unitId, transcript, reply, yieldsToUnits);
      }

      if (outcome === "processed") {
        if (!speakText) {
          outcome = "no_on_air_reply";
          error =
            "AI processed this but had nothing to say on the radio (often chitchat with no dispatcher_response).";
        } else if (!spokeOnAir) {
          outcome = "tts_failed";
          error =
            error ??
            "TTS or on-channel playback failed. Check ElevenLabs API key and voice ID under Admin → Integrations.";
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
      if (emergencyRegex === "activate") {
        await applyChannelTen33Marker({
          loopbackPort,
          agencyId: tx.agency_id,
          channelName: tx.channel_name,
          active: true,
          markerUnitId: platform.dispatchUnitId,
          source: "regex",
          startAudioLoop: false,
        });
        ten33Activated = true;
        const reply = adaptDispatcherResponseForChannel(defaultTen33Callout(tx.channel_name), tx.channel_name);
        spokeOnAir = await speakDispatcherReply(tx, transmissionId, unitId, transcript, reply, yieldsToUnits);
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
    const answer = await buildInfoRequestResponse(
      tx.agency_id,
      parsed.info_request,
      parsed.unit ?? unitId,
    );
    const reply = adaptDispatcherResponseForChannel(
      answer || `${parsed.unit ?? unitId}, negative, lookup failed.`,
      tx.channel_name,
    );
    await speakDispatcherReply(tx, transmissionId, unitId, transcript, reply, yieldsToUnits);
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
      },
      plateLookup: null,
      ten8Actions: null,
      error: null,
      outcome: "followup_info",
      durationMs: 0,
    });
    console.log(`[ai-dispatch] info_request async answer agency=${tx.agency_id} type=${parsed.info_request.type}`);
  } catch (err) {
    console.warn("[ai-dispatch] async info_request failed", err);
    const fallback = adaptDispatcherResponseForChannel(
      `${parsed.unit ?? unitId}, negative, lookup failed.`,
      tx.channel_name,
    );
    await speakDispatcherReply(tx, transmissionId, unitId, transcript, fallback, yieldsToUnits).catch(
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
): Promise<boolean> {
  const mp3 = await synthesizeElevenLabsMp3(tx.agency_id, reply);
  if (!mp3) {
    console.warn(
      `[ai-dispatch] ElevenLabs returned no audio agency=${tx.agency_id} channel=${tx.channel_name}`,
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
