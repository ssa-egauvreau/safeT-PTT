# AMBE+2 (P25 Phase 2) codec pilot — test runbook

The platform now ships a fourth voice codec, **AMBE+2 2450** — the half-rate
vocoder APCO P25 Phase 2 (and DMR) systems use on the air, the same frames
sdrtrunk decodes as "AMBE 3600x2450". It supplements IMBE (default), Codec2
3200, and Opus. This runbook is the click-by-click plan for piloting it on a
test channel without disrupting normal operations.

## What to expect

| | IMBE (today's default) | AMBE+2 2450 |
|---|---|---|
| Vocoder | P25 Phase 1 full-rate | P25 Phase 2 half-rate |
| Voice payload | 11 B / 20 ms frame | 9 B / 20 ms frame |
| Wire frame (with magic) | 13 B | 11 B (~15 % less voice data) |
| Character | The familiar "P25 radio" sound | Slightly more compressed / "thinner"; the trade for half the on-air rate |

Both run at 8 kHz with the same mic conditioning and post-decode shaping, so
an A/B at the same volume is a fair comparison.

## Before you start

1. **Update every handset that will touch the test channel first.** Clients
   older than this release don't recognize the AMBE frame magic and hear
   **silence** on an AMBE channel (same rollout behavior as when Codec2 and
   Opus were added). Web console users just need a browser refresh after the
   server deploys.
2. iOS users: re-run `./setup.sh` and rebuild after pulling (generated Xcode
   project — see `docs/ios-xcode-after-pull.md`).
3. Pick a **low-traffic test channel** (or create one: safeT Control →
   Channels → Add channel). Don't pilot on a primary dispatch channel.

## Step 1 — Hear it before going live (Audio Lab)

1. Sign in to safeT Control as an agency admin → **Audio Lab**.
2. Set the **codec** dropdown to **AMBE+2 2450 (P25 Phase 2)**.
3. Record a clip and use the round-trip playback to hear exactly what the
   codec does to speech. Flip between IMBE and AMBE on the same clip to A/B.
4. Optional: run the codec benchmark to confirm encode/decode timings on the
   console hardware.

## Step 2 — Flip the test channel

1. safeT Control → **Channels** → find the test channel.
2. Change its codec to **AMBE+2 2450 (P25 Phase 2)** and save.
3. Connected clients pick the change up immediately via the `codec_change`
   push — no rejoin needed. The next key-up transmits AMBE.

## Step 3 — Live test matrix

Key up on the test channel from each client type and confirm every other
client hears clean audio:

| TX ↓ / RX → | Android | iOS | Web console |
|---|---|---|---|
| Android | ✓ | ✓ | ✓ |
| iOS | ✓ | ✓ | ✓ |
| Web console | ✓ | ✓ | ✓ |

Also verify:

- **Scan**: a radio homed on another channel with the test channel in its
  scan list hears the AMBE traffic.
- **Recording + transcription**: each test transmission appears in the
  Transmission Log with playable audio and a transcript (the server decodes
  AMBE for the recorder the same way it does IMBE).
- **Mixed codecs**: a unit still on an IMBE channel is unaffected — receivers
  pick the decoder per frame, so mid-rollout mixes are safe.

## Step 4 — Check the dashboards

After ~10 minutes of traffic, in safeT Control → **Link Health**:

- The test units' **codec mix** column should show `ambe_2450`.
- **PLC ratio / underruns** should look no worse than the same units on IMBE.
- **Data used** should trend slightly lower than IMBE for the same talk time
  (11 B vs 13 B per voice frame; the recorder sideband dominates uplink, so
  expect a modest difference, not 15 %).

## Rollback

Set the channel's codec back to **IMBE (P25, default)** in safeT Control →
Channels. The change pushes live the same way; nothing else to undo.

## Known limitations during the pilot

- **Old app builds hear silence** on the AMBE channel until updated.
- **Bridge console** (local radio bridges) monitors decode IMBE only for its
  level meters; bridge audio ingest itself is codec-agnostic. AMBE support
  there is a small follow-up if bridges join AMBE channels.
- The AMBE encoder in the bundled dvmvocoder is the community implementation
  (same GPL tree as our IMBE); if a talk-spurt's first ~2 frames sound soft,
  that's the vocoder's normal history priming, identical to IMBE.
