# Voice quality: jitter, PLC, and underruns

Field symptom: audio cutting in and out, garbled or missed transmissions, the
Link Health dashboard showing red `DEGRADED` badges with high PLC ratios and
hundreds of buffer underruns — across all codecs, somewhat worse on the 8 kHz
vocoders (IMBE / Codec2 / AMBE+2) than on Opus.

## What actually causes it

Voice travels over WebSockets (TCP), so frames are never *lost* — they arrive
**late, in bursts**. Every "PLC frame" on the dashboard is a frame that missed
its 20 ms playout slot. Three things were producing that lateness:

1. **Whisper ran on the relay's event loop.** Transcription
   (`transformers.js` / ONNX) executed in the same Node process *and thread*
   that forwards every voice frame. One transmission's transcription is
   seconds of CPU (≈5 s per 1 s of audio on a small container), and its
   JS-side feature extraction blocks the event loop outright — so the relay
   froze, then dumped a burst, on every recorded transmission, for every
   connected client (this is why the *web console* on wired networks was
   degraded too). Fixed: the Whisper pipeline now runs in a
   `worker_threads` worker (`transcribeWorker.ts`); the relay thread only
   passes WAV bytes and DB writes.

2. **The handset jitter buffer could not recover from its first stall.** It
   cushioned 80 ms at track creation only; after the first underrun it ran
   pinned at zero depth, turning every subsequent ±20 ms of jitter into
   another underrun (the machine-gun PLC/late/PLC/late stutter). It also tore
   the AudioTrack down 300 ms after the last frame — so a *mid-transmission*
   network stall ≥300 ms paid track re-init on top of the stall — and capped
   buffered audio at 320 ms, silently discarding the front of any
   post-stall TCP burst (heard as garble / "missed" speech). Fixed: the
   buffer is now adaptive (80→240 ms target that grows on underruns and
   decays on clean transmissions), re-buffers to target after an underrun
   instead of free-running at depth zero, holds the track for 1.5 s of idle,
   and absorbs up to 1 s of burst.

3. **Screen-off power management.** Without a wake lock, the CPU naps between
   packets and Wi-Fi power-save batches delivery — bursty RX exactly like
   network jitter. `RadioPresenceService` now holds a partial wake lock and a
   low-latency Wi-Fi lock while running (the same trade Zello's "keep awake"
   makes). Make sure handsets also grant the battery-optimization exemption
   the app requests, or Doze can still suspend the socket entirely
   (= fully missed transmissions while stationary with the screen off).

### Why Opus sounded better than IMBE / Codec2 / AMBE+2

All codecs ship identical 20 ms frames through the same path, so they suffer
the same *timing* damage. Opus merely degrades more gracefully: 16 kHz
wideband output stays intelligible around gaps, while the 8 kHz vocoders turn
the same gaps into robotic garble (their decoders carry inter-frame state).
Codec settings are not the cause; with the jitter sources fixed all codecs
smooth out.

## If it recurs — checklist

- `GET /health` (diagnostics include transcription state and queue depth): a
  growing `queue_depth` with degraded audio means the container is CPU-starved
  — give the service more vCPU, or set `TRANSCRIPTION=off` to confirm the
  correlation.
- Whisper still *competes for CPU* from its worker thread. On a 1-vCPU
  instance, prefer `TRANSCRIPTION=off` or a bigger instance. The same applies
  to KB embeddings (`KB_ENABLED=off`) and AI dispatch on busy systems; moving
  those into the worker is a known follow-up.
- Link Health: underruns ≈ outage *frequency*, PLC ratio ≈ concealment
  *volume*, max buffer depth near 50 ≈ chronic upstream burstiness (look at
  the server, not the handset).
- A unit that is degraded only when in a pocket / screen-off: verify the
  battery-optimization exemption and any OEM "app sleep" allowlists
  (Samsung "never sleeping apps", etc.).
