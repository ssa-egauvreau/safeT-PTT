# Voice and air timing (all clients)

Shared numbers for half-duplex voice, talker hints, and RX idle detection. When you change one platform, update this doc and the matching constants.

| Constant | Value | Where used |
|----------|-------|------------|
| `VOICE_AIR_TTL_MS` | **900 ms** | Server `voiceRelay.ts` — fallback after last frame if no `release_air` |
| Talk-spurt gap | **300 ms** | Android/iOS/Web — reset Codec2/Opus/PLC/post-decode between spurts |
| `release_air` | On PTT release | Android, web, iOS, radio bridge — clear `/v1/air` immediately |
| Air poll while PTT | **250 ms** | Android (and iOS after parity) |
| Talk-activity poll (idle) | **1200 ms** | Android, web dispatch |
| Talk-activity poll (active RX) | **400 ms** | Android, web (when receiving / talker shown) |
| Inbox poll | **2000 ms** | Android, iOS |
| Presence poll | **12000 ms** | Android, iOS |
| Web RX idle (`RX_GAP_MS`) | **300 ms** | Web console — matches mobile talk-spurt gap |

## Source of truth in code

| Area | File |
|------|------|
| Server TTL | `server/src/voiceRelay.ts` (`VOICE_AIR_TTL_MS`) |
| Web console | `server/web-console/src/voice/voiceTiming.ts` |
| iOS | `ios-app/SafeTMobile/Support/VoiceTiming.swift` |
| Android | `RadioViewModel.kt` companion constants |

## Client checklist

- [ ] PTT release sends `{"type":"release_air"}` on an open voice WebSocket
- [ ] Opus: flush encoder before `release_air` (web)
- [ ] Codec2/Opus: `resetForTalkSpurt()` on TX gap and RX spurt boundary
- [ ] `/v1/talk-activity` + `/v1/air` drive “who is talking” on field radios
- [ ] Inbox `ten33` list drives 10-33 band on tuned channel (Android/iOS)
