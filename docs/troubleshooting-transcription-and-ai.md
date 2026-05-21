# Troubleshooting: no transcripts and AI not responding

The server is a **chain**. If any step breaks, you get no transcript and no AI voice.

```text
You press PTT → audio saved (needs database)
            → Whisper transcribes (needs transcription on)
            → AI reads transcript (needs AI_DISPATCH_ENABLED + channel AI ON)
            → ElevenLabs speaks (needs Integrations API key)
```

## Quick check (no login)

Open in a browser:

`https://safet.up.railway.app/health`

Look at the JSON:

| Field | Good | Bad — what it means |
|--------|------|---------------------|
| `database` | `true` | `false` — **DATABASE_URL** missing on Railway; nothing is recorded |
| `transcription.state` | `ready` | `broken` — Whisper failed to load (often out of memory); transcripts fail |
| `transcription.enabled` | `true` | `false` — **TRANSCRIPTION** is set to `off` on Railway |
| `ai_dispatch.enabled` | `true` | `false` — **AI_DISPATCH_ENABLED** is not `1` |
| `ai_dispatch.llm_configured` | `true` | `false` — **AI_DISPATCH_LLM_API_KEY** missing |

`status: "degraded"` means something in that chain is wrong.

## In the web console

1. Sign in → open **Transmissions** (or the channel transmission list).
2. Transmit on the radio, wait ~10–20 seconds, refresh.

| What you see | Meaning |
|--------------|---------|
| **No new row at all** | Recording not saving — check **database** on `/health` and that you are on the right agency/channel |
| **Transcribing…** (stuck) | Whisper still loading or stuck — check Railway logs for `Transcriber` |
| **Transcript unavailable** | Whisper failed — redeploy or increase Railway memory |
| **Transcription disabled** | Set `TRANSCRIPTION=on` on Railway (or remove `TRANSCRIPTION=off`) |
| Transcript text OK, no AI voice | AI dispatch — see below |

## AI Log shows only 1–2 lines but dispatch shows many transmissions

Those are **two different logs**:

| Page | What it lists |
|------|----------------|
| **Dispatch transmission log** | Every recorded key-up (always) |
| **AI dispatch activity** | Only traffic where the AI engine ran or **skipped** (with a reason) |

After the latest server update, skipped rows appear as **“Skipped — AI OFF on channel”**, **“Skipped — no speech”**, or **“Skipped — duplicate/simulcast”**. Turn **AI DISPATCH ON** on the channel you are testing if most rows say channel OFF.

---

## AI dispatch checklist (Railway Variables)

| Variable | Required value |
|----------|----------------|
| `AI_DISPATCH_ENABLED` | `1` |
| `AI_DISPATCH_LLM_API_KEY` | Anthropic `sk-ant-…` (same as old `ANTHROPIC_API_KEY`) |
| `DATABASE_URL` | Linked from Postgres service |

**Admin → Integrations** (your agency):

- ElevenLabs API key and voice ID filled in

**Dispatch console → channel panel:**

- **AI DISPATCH** toggle is **ON** for the channel you are testing

## Railway logs (2 minutes)

1. Railway → safeT service → **Deployments** → latest → **View logs**.
2. Search for:

- `Transcriber ready` — good
- `Transcriber unavailable` — Whisper failed (try larger plan or redeploy)
- `Whisper model load exceeded` — the model took too long to load (slow/blocked HF download or OOM). The queue no longer freezes; affected transmissions are marked failed and the load keeps retrying. Tune with `WHISPER_LOAD_TIMEOUT_MS` (default 180000).
- `Database bootstrap failed` — Postgres problem
- `[ai-dispatch]` lines — AI ran or skipped

### Stuck on "Transcribing…" forever

Every transmission staying at **Transcribing…** means the model never finished loading and the worker was blocked on it. After this update the worker stops waiting after `WHISPER_LOAD_TIMEOUT_MS` and the AI activity log shows **“Transcription failed (Whisper unavailable…)”** so the cause is visible. The underlying fix is usually a larger Railway memory plan (the model is loaded in-process) or confirming the container can reach the Hugging Face model download.

## Redeploy

After changing variables: **Deploy** or push to `main` and wait for **Success**, then test again.
