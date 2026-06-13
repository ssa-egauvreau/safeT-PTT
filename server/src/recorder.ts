// Records each talk-spurt on a channel into the transmissions table, then hands it
// to the transcriber. A talk-spurt ends after a short gap with no frames.

import { getPool } from "./db.js";
import { insertTransmission, setTranscript } from "./store.js";
import { encodeWavPcm16, upsample8kTo16k } from "./wav.js";
import { enqueueTranscription } from "./transcribe.js";
import { isAiDispatchChannelCached } from "./aiDispatch/channelCache.js";
import { createImbeDecoder } from "./imbeServerCodec.js";
import { createCodec2Decoder } from "./codec2ServerCodec.js";
import { createOpusDecoder } from "./opusServerCodec.js";
import { createAmbeDecoder } from "./ambeServerCodec.js";
import { detectFrameCodec, type VoiceCodec } from "./voiceCodecs.js";

/** Transcribe bridge (SDR / radio) ingest too? Off by default: scanner traffic
 *  is a firehose (Scan All records every decoded call) that floods the single
 *  Whisper worker and starves handset transmissions. Set TRANSCRIBE_BRIDGE=on
 *  to restore transcription for bridge audio. */
const TRANSCRIBE_BRIDGE = (process.env.TRANSCRIBE_BRIDGE ?? "off").trim().toLowerCase() === "on";

const SAMPLE_RATE = 16000;
/** Silence after the last frame that closes a transmission. */
const GAP_MS = 1500;
/** Hard cap; longer holds are split into separate recordings. */
const MAX_MS = 5 * 60 * 1000;
/** Ignore key bumps shorter than this (~300 ms of 16 kHz mono PCM-16). */
const MIN_BYTES = Math.round(SAMPLE_RATE * 2 * 0.3);

/** Common shape of every server-side vocoder decoder. Both
 *  [ImbeStreamDecoder] and [Codec2StreamDecoder] satisfy this — the
 *  recorder just calls decode/free without caring which codec is doing
 *  the work. */
interface VoiceStreamDecoder {
  decode(framed: Buffer): Buffer | null;
  free(): void;
}

/** Codecs the server can decode for the recorder. All four native codecs
 *  have a server-side WASM decoder (libopus joined IMBE + Codec2 in the
 *  libopus-FEC PR; AMBE+2 half-rate shares the dvmvocoder module with
 *  IMBE); the clear-PCM sideband is still used when the WASM fails to
 *  load or when an agency policy keeps it on. */
const SERVER_DECODABLE: ReadonlySet<VoiceCodec> = new Set(["imbe", "codec2_3200", "opus", "ambe_2450"]);

/** Factory map keyed by codec — the per-recording decoder is allocated
 *  lazily on the first vocoded frame of each talk-spurt so a channel
 *  that only ever sees clear-PCM never pays the WASM init cost. */
const DECODER_FACTORIES: Record<VoiceCodec, (() => VoiceStreamDecoder | null) | null> = {
  imbe: createImbeDecoder,
  codec2_3200: createCodec2Decoder,
  opus: createOpusDecoder,
  ambe_2450: createAmbeDecoder,
};

/** Log "no server decoder for X" once per codec per process to avoid spam. */
const warnedNoDecoder = new Set<VoiceCodec>();

export interface FrameAttribution {
  agencyId: number;
  channelNorm: string;
  channelName: string;
  channelId: number | null;
  userId: number | null;
  unitId: string;
  displayName: string | null;
  /** AI dispatch on this channel — uplink clear PCM for AI (also skips IMBE in the recording). */
  aiDispatchListenPcm?: boolean;
  /**
   * When true (default for all relay traffic), the transmission log stores only
   * clear PCM frames so Whisper is not fed decoded IMBE audio.
   */
  recordListenPcm?: boolean;
  /** True for bridge ingest (SDR / radio bridges). The recording is still
   *  stored and playable, but Whisper is skipped unless TRANSCRIBE_BRIDGE is on
   *  so scanner traffic can't flood the single-worker transcription queue. */
  fromBridge?: boolean;
}

/** Recordings are tracked per agency + channel so tenants never share a talk-spurt. */
function recKey(attr: { agencyId: number; channelNorm: string }): string {
  return `${attr.agencyId} ${attr.channelNorm}`;
}

interface ActiveRecording extends FrameAttribution {
  startedAt: number;
  lastFrameMs: number;
  chunks: Buffer[];
  bytes: number;
  /** Decoders dedicated to this talk-spurt's digital frames, keyed by
   *  codec. Codec state carries frame-to-frame (LPC / pitch / sine
   *  history) so each (recording, codec) pair gets its own decoder. A
   *  mid-talk-spurt codec change (rare but possible) allocates a second
   *  entry rather than reusing the first. */
  decoders: Map<VoiceCodec, VoiceStreamDecoder>;
}

const active = new Map<string, ActiveRecording>();
let sweepTimer: NodeJS.Timeout | null = null;

/** Identifies a vocoded frame (any codec) by its leading magic bytes — used to
 *  decide whether the recorder should decode the payload or skip it in favor
 *  of the clear-PCM sideband. Anything that isn't a known codec falls through
 *  and is treated as raw PCM. */
function frameVocoder(payload: Buffer): VoiceCodec | null {
  return detectFrameCodec(payload);
}

async function finalize(rec: ActiveRecording): Promise<void> {
  if (active.get(recKey(rec)) === rec) {
    active.delete(recKey(rec));
  }
  for (const dec of rec.decoders.values()) {
    dec.free();
  }
  rec.decoders.clear();
  if (rec.bytes < MIN_BYTES) {
    return;
  }
  const pcm = Buffer.concat(rec.chunks, rec.bytes);
  const durationMs = Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000);
  try {
    const id = await insertTransmission({
      agencyId: rec.agencyId,
      channelId: rec.channelId,
      channelName: rec.channelName,
      userId: rec.userId,
      unitId: rec.unitId,
      displayName: rec.displayName,
      startedAt: new Date(rec.startedAt),
      endedAt: new Date(rec.lastFrameMs),
      durationMs,
      sampleRate: SAMPLE_RATE,
      audio: encodeWavPcm16(pcm, SAMPLE_RATE),
    });
    if (rec.fromBridge && !TRANSCRIBE_BRIDGE) {
      // Recording is saved and playable; just don't queue scanner audio for
      // Whisper (terminal 'skipped' renders as a neutral "—" on the console).
      void setTranscript(id, "skipped", null).catch(() => undefined);
    } else {
      enqueueTranscription(id);
    }
  } catch (error) {
    console.warn("Failed to save transmission recording", error);
  }
}

/**
 * Feeds one accepted relay frame into the recorder. Call after the frame is
 * broadcast. [pcmSampleRate] applies only to the clear-PCM sideband (raw, no
 * codec magic): an 8 kHz sideband is upsampled to [SAMPLE_RATE] so the stored
 * recording is always 16 kHz. Vocoded frames ignore it (decoders define rate).
 */
export function recordFrame(
  attr: FrameAttribution,
  payload: Buffer,
  pcmSampleRate: number = SAMPLE_RATE,
): void {
  if (!getPool() || payload.length === 0) {
    return;
  }
  const now = Date.now();
  const key = recKey(attr);
  let rec = active.get(key);
  if (rec && rec.unitId !== attr.unitId) {
    void finalize(rec);
    rec = undefined;
  }
  if (!rec) {
    rec = {
      ...attr,
      startedAt: now,
      lastFrameMs: now,
      chunks: [],
      bytes: 0,
      decoders: new Map(),
    };
    active.set(key, rec);
  }
  const preferClearPcm =
    attr.recordListenPcm !== false ||
    attr.aiDispatchListenPcm === true ||
    isAiDispatchChannelCached(attr.agencyId, attr.channelName);

  // Transmission log + Whisper need clear PCM — decoded vocoder audio (any codec)
  // is poor for speech-to-text. Drop a vocoded frame when the clear-PCM sideband
  // is being shipped, regardless of which codec the frame is in.
  let pcm: Buffer;
  const codec = frameVocoder(payload);
  if (codec !== null) {
    if (preferClearPcm) {
      return;
    }
    if (!SERVER_DECODABLE.has(codec)) {
      if (!warnedNoDecoder.has(codec)) {
        warnedNoDecoder.add(codec);
        console.warn(
          `Recorder has no server-side decoder for ${codec}; dropping vocoded frames on this channel ` +
            `(transmissions still record via the clear-PCM sideband).`,
        );
      }
      return;
    }
    let decoder = rec.decoders.get(codec);
    if (!decoder) {
      const factory = DECODER_FACTORIES[codec];
      if (!factory) {
        return;
      }
      const created = factory();
      if (!created) {
        // Codec lib failed to load (WASM init error, mismatched mode); the
        // factory already logged once. Drop the frame; later frames retry.
        return;
      }
      decoder = created;
      rec.decoders.set(codec, decoder);
    }
    const decoded = decoder.decode(payload);
    if (!decoded) {
      return;
    }
    pcm = decoded;
  } else {
    // Raw clear-PCM sideband. Bring a downsampled (8 kHz) sideband back up to
    // 16 kHz so every stored recording shares one sample rate.
    pcm = pcmSampleRate === 8000 ? upsample8kTo16k(payload) : payload;
  }
  // ws may reuse the frame buffer — copy before retaining it.
  rec.chunks.push(Buffer.from(pcm));
  rec.bytes += pcm.length;
  rec.lastFrameMs = now;
  if (now - rec.startedAt >= MAX_MS) {
    void finalize(rec);
  }
}

function sweep(): void {
  const now = Date.now();
  for (const rec of [...active.values()]) {
    if (now - rec.lastFrameMs > GAP_MS) {
      void finalize(rec);
    }
  }
}

/** Starts the periodic talk-spurt finalizer. */
export function startRecorder(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(sweep, 500);
  if (typeof sweepTimer.unref === "function") {
    sweepTimer.unref();
  }
}
