# Plan: Opus packet-loss recovery (in-band FEC / LBRR) on the decode side

Status: **proposal — not yet implemented.** Author handoff for review before build.

## Problem

The Opus encoder already emits in-band FEC (LBRR): each packet carries a
low-bitrate redundant copy of the *previous* frame. We pay the bitrate cost on
every packet today. But **no client ever uses it on decode** — on a lost frame
all three clients fall back to PLC (replay-last-frame-with-fade), which is the
"robotic / cutting-out on cellular" symptom. The decode-side recovery functions
exist but are dead code:

- web: `opusDecodeFec()` — `server/web-console/src/voice/opusWasmCodec.ts:132` (0 callers)
- Android: `OpusVoiceCodec.decodeLostFrameFromNext()` (0 callers)
- iOS: `OpusVoiceCodec.decodeLostFrameFromNext(fec:true)` — `OpusVoiceCodec.swift:221` (0 callers)

## Why it isn't a one-line wire-up

LBRR recovers frame **N** from the packet for frame **N+1**. To use it the
receiver must:

1. **Know frame N was lost** (not merely late), and
2. **Have frame N+1 in hand** (so it can extract N's redundant copy), then
3. Decode N via FEC, then normally decode N+1.

Today neither (1) nor (2) is possible:

- **No sequence numbers on the wire.** A voice frame is exactly
  `[magic0][magic1][opus payload]` (see `CODEC_MAGIC` in
  `server/src/voiceCodecs.ts`). The relay forwards frames **by magic byte,
  passing the bytes through unchanged** — it never re-frames. With no seq
  number the receiver cannot distinguish "lost" from "late," and the jitter
  buffers currently treat an empty queue at playout time as loss → immediate
  PLC.
- **No look-ahead.** Jitter buffers pull-at-playout and emit PLC the instant
  the queue is empty; there is no one-frame hold that would let frame N+1
  arrive before we give up on N.

So this is a **voice wire-format change**, shared by the relay and all three
clients, not a local tweak.

## Proposed design

### 1. Wire: add a 1-byte sequence number (backward compatible)

New Opus-with-seq frame layout:

```
[0x4f][0x70][seq:1 byte][opus payload...]
        ^^^ unchanged magic     ^^^ existing payload, unchanged
```

- `seq` is a mod-256 counter the **sender** increments per Opus frame within a
  talk-spurt (reset to 0 on talk-spurt start, alongside the existing
  encoder/jitter resets).
- **Relay needs no change**: it matches the first two magic bytes and passes
  the rest through verbatim — the seq byte rides along as opaque payload.
- **Backward compat is the crux.** An *old* receiver does
  `payload.subarray(2)` and feeds the rest to `opus_decode` — if we insert a
  seq byte, an old client would feed `[seq][opus]` to the decoder and corrupt
  every frame. Two options:
  - **(A) Capability negotiation:** only emit seq-framed Opus when the channel
    is known all-FEC-capable (server gates via a per-channel/agency flag once
    all clients ship the new build). Safest; needs a rollout flag.
  - **(B) New magic byte for seq-framed Opus** (e.g. `0x4f 0x71`): old clients
    don't recognize it and drop (audible gap), new clients decode + FEC. Clean
    but old clients lose Opus audio entirely during rollout.
  - **Recommendation: (A)** — no audio loss during mixed-version rollout;
    seq-framing activates only when every peer on the channel supports it.

### 2. Receiver: 1-frame look-ahead + FEC trigger in the jitter buffer

In each `InboundJitterBuffer` (web `voiceClient` playout / Kotlin / Swift):

- Track `lastPlayedSeq`. On the next dequeued packet with seq `s`:
  - If `s == lastPlayedSeq + 1` → normal decode.
  - If `s == lastPlayedSeq + 2` → **exactly one frame lost AND we have the next
    packet**: run FEC recovery to synthesize the missing frame from this
    packet's LBRR, play it, then normal-decode this packet. This is the case
    LBRR is designed for.
  - If gap > 2, or the next packet hasn't arrived by the playout deadline →
    fall back to existing PLC (unchanged).
- Keeps steady-state latency identical; the look-ahead only costs time in the
  loss case, bounded by the existing playout deadline.

### 3. Per-platform integration points

| Platform | Add seq on send | Look-ahead + FEC on recv |
|---|---|---|
| web | Opus encode path in `voiceClient.ts` | playout/underrun region (`schedulePcm`, ~L871) using `opusDecodeFec()` |
| Android | `OpusVoiceCodec` encode + `VoiceRelayTransport` send | `InboundJitterBuffer.nextPlayoutFrame` using `decodeLostFrameFromNext()` |
| iOS | `OpusVoiceCodec` encode + `VoiceTransport` send | `InboundJitterBuffer.playoutLoop` using `decodeLostFrameFromNext(fec:)` |

### 4. Tests

- Server: seq framing round-trip + relay passthrough unchanged (no decode on
  relay).
- web (unit-testable, runs in CI): jitter buffer FEC trigger on seq gap of 2,
  PLC fallback on gap > 2 and on missing next packet, seq wrap at 255→0.
- Native: mirror the web logic; covered by build CI + targeted unit tests where
  the harness allows.

## Effort / risk

- **Effort:** medium-large. ~3 client send paths + 3 receive paths + a server
  capability flag + tests. No new native deps (FEC funcs already exist).
- **Risk:** touches the shared voice wire format → mixed-version rollout is the
  main hazard; mitigated by capability gating (option A) so seq-framing only
  turns on when all peers support it.
- **Latency:** unchanged in steady state; recovery path bounded by the existing
  playout deadline.

## Open questions for review

1. Capability gating (A) vs new magic byte (B)? (Recommend A.)
2. Is 1-byte (mod-256) seq enough? At 20 ms/frame that wraps every ~5.1 s — far
   longer than any single talk-spurt gap we'd FEC across, so yes.
3. Do we also want to expose Opus's *built-in* PLC (`opus_decode(NULL)`) as a
   better concealment than replay-with-fade, independent of FEC? Cheap win,
   no wire change — could ship first.
