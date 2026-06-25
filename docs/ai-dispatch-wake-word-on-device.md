# On-device wake-word gate for AI dispatch

This is the cost/latency optimization for **supervised** AI-dispatch channels: instead of uploading
and transcribing *every* transmission just to check whether it opened with the wake word, the
handset spots the wake word locally and tells the server. The server then only pays for the
(accurate, cloud) transcription of transmissions actually addressed to the dispatcher.

The server stays **authoritative** — it still transcribes and re-checks the wake word on everything
that passes the gate — so the on-device spotter only needs to be **recall-safe**: it must never
classify a real wake word as `none`. False positives cost nothing.

## How it fits together (already in the codebase)

| Piece | Where | Status |
|-------|-------|--------|
| Agency wake phrase (default `hey ai`) | `agency_integrations["ai_dispatch_wake_word"]`; Admin → Integrations; `resolveAiDispatchWakeWord()` | **live** |
| Delivered to handsets | `GET /v1/me/channels` → `wake_word` → `RadioChannelCatalog.wakeWord` → `RadioPreferences.getAiWakeWord()` | **live** |
| `tx_meta { "wake": … }` frame | `VoiceRelayTransport.sendTxMeta()` → `voiceRelay.ts` `handleVoiceControl` | **live** |
| Server gate | `recorder.ts` finalize: supervised + `wake=none` → local lane, not paid cloud | **live (no-op until hints arrive)** |
| On-device spotter | `WakeWordSpotter` / `WakeWordGate` (Android) | **scaffold only — `StubWakeWordSpotter` returns `maybe`** |

The gate is fully wired but **inert** until: (1) a trained model replaces `StubWakeWordSpotter`, and
(2) `RadioPreferences.setWakeWordGateEnabled(true)`.

## Engine: openWakeWord

Chosen for license (Apache-2.0, no per-device fees) and a ~1-hour custom-model training path.
Runs a shared pretrained melspectrogram + embedding front-end and a small **per-phrase** classifier
(the only custom artifact, a few hundred KB). Inference via TFLite on-device.

## Producing the `hey ai` model

1. Open the openWakeWord training Colab (linked from the [repo](https://github.com/dscripka/openWakeWord)).
2. Set the target phrase to the agency wake word (default **`hey ai`**). Note: short phrases are
   harder to spot; if a fleet wants maximum reliability, a more distinctive phrase like
   `hey dispatch` spots better — the wake word is agency-configurable, so this is a per-fleet choice.
3. The notebook uses Piper TTS to synthesize thousands of positive samples (varied voices/speeds/noise)
   plus a large negative set (general speech + radio chatter). Train, then **export the TFLite**
   wakeword model.
4. Drop the three `.tflite` files into `android-app/app/src/main/assets/wakeword/`
   (`melspectrogram.tflite`, `embedding_model.tflite`, and `<slug>.tflite`, e.g. `hey_ai.tflite`).
   `OpenWakeWordSpotter` is already implemented and wired in — it runs the mel → embedding →
   classifier pipeline over the buffered PCM and self-disables (returns `maybe`) until these assets
   are present. On first integration, confirm the model tensor shapes / preprocessing constants in
   `OpenWakeWordSpotter` match the shipped models (a mismatch is caught and self-disables).

## Recall-safe thresholds

The classifier emits a 0–1 score per frame. Use two cutoffs over the utterance's peak score:

- `score ≥ HIGH` → `clear`
- `LOW ≤ score < HIGH` → `maybe`
- `score < LOW` → `none`

Only `none` changes server behavior (routes off the paid cloud lane). Tune `LOW` **low** so a real
`hey ai` never lands in `none`. `HIGH` is informational for now.

## Rollout (measure before you gate)

1. Ship the spotter with the **enable flag off**. Log, per transmission, the device hint vs the
   server's `stripSupervisedWakeWord` verdict.
2. From the logs, compute the false-negative rate (device said `none` but the server found the wake
   word). Lower `LOW` until that rate is ~0 on the fleet's real audio/head-units.
3. Flip `setWakeWordGateEnabled(true)` per agency. The savings (skipped OpenAI Whisper minutes) scale
   with how much supervised traffic isn't addressed to the dispatcher.

## What's deliberately *not* on the device

The LLM reasoning, knowledge-base retrieval, CAD/Ten-8, plate/geocode/web lookups, and the
ElevenLabs dispatcher voice all stay server-side — the dispatcher is a channel-level, multi-tenant,
data-bound service. Only the cheap wake-word *gate* lives at the edge.
