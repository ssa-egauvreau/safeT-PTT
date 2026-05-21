import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  getChannelAiDispatchRow,
  getTransmissionDispatchContext,
} from "../store.js";
import { generateDispatcherReply } from "./llm.js";
import {
  getAiDispatchPlatformConfig,
  isAiDispatchUnit,
  resolveAiDispatchSystemPrompt,
} from "./platformConfig.js";
import { playMp3UrlOnChannel } from "./playback.js";
import { synthesizeElevenLabsMp3 } from "./tts.js";
import { postOutboundWebhook } from "./webhook.js";

const queue: number[] = [];
let working = false;
let loopbackPort = 8080;

export function configureAiDispatchEngine(options: { port: number }): void {
  loopbackPort = options.port;
}

export function enqueueAiDispatchForTransmission(transmissionId: number): void {
  const platform = getAiDispatchPlatformConfig();
  if (!platform.enabled) {
    return;
  }
  queue.push(transmissionId);
  void pump();
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

async function processTransmission(transmissionId: number): Promise<void> {
  try {
    const tx = await getTransmissionDispatchContext(transmissionId);
    if (!tx) {
      return;
    }
    if (isAiDispatchUnit(tx.unit_id)) {
      return;
    }

    const channelRow = await getChannelAiDispatchRow(tx.agency_id, tx.channel_name);
    if (!channelRow?.enabled) {
      return;
    }

    const transcript = await loadTranscriptText(transmissionId);
    if (!transcript) {
      return;
    }

    const systemPrompt = await resolveAiDispatchSystemPrompt(tx.agency_id);
    const unitId = (tx.unit_id ?? "UNIT").trim().toUpperCase() || "UNIT";
    const reply = await generateDispatcherReply({
      systemPrompt,
      unitId,
      channelName: tx.channel_name,
      transcript,
    });
    if (!reply) {
      return;
    }

    const mp3 = await synthesizeElevenLabsMp3(tx.agency_id, reply);
    if (!mp3) {
      return;
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
        yieldsToUnits: channelRow.yields_to_units,
        mp3Url: tmpPath,
      });
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
  } catch (err) {
    console.warn(`[ai-dispatch] failed for transmission ${transmissionId}`, err);
  }
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
