# Integrations and AI dispatcher

safeT separates **who configures what**:

| Layer | Where | Examples |
|-------|--------|----------|
| **Platform (Railway env)** | Server operator | AI dispatcher on/off, LLM API key, model, **default** system prompt |
| **Per agency (Admin → Integrations)** | Each tenant’s admin | ElevenLabs API key & voice, **agency system prompt** (10-codes, call signs), outbound webhook |
| **Per channel (dispatch console)** | Channel panel | Turn AI dispatcher on/off per channel (like 10-33 marker) |

License plate lookup, VIN decode, and similar tools will use **Integrations → Lookups** when those portal features are added.

---

## Railway environment variables (AI dispatcher)

Set these on the **safeT PTT** service in Railway (not in the Integrations page).

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_DISPATCH_ENABLED` | No | `1` / `true` to allow AI dispatch when agency + channel are configured. Default off. |
| `AI_DISPATCH_LLM_API_KEY` | For AI | API key for the LLM provider (OpenAI-compatible). |
| `AI_DISPATCH_LLM_BASE_URL` | No | Default `https://api.openai.com/v1` |
| `AI_DISPATCH_LLM_MODEL` | No | Default `gpt-4o-mini` |
| `AI_DISPATCH_SYSTEM_PROMPT` | No | **Fallback** dispatcher prompt if the agency leaves Integrations prompt empty |
| `AI_DISPATCH_UNIT_ID` | No | Unit id on the radio when AI keys up (default `AI-DISPATCH`) |
| `AI_DISPATCH_YIELDS_DEFAULT` | No | Default `1` — AI yields to live units on a channel |

Example:

```env
AI_DISPATCH_ENABLED=1
AI_DISPATCH_LLM_API_KEY=sk-...
AI_DISPATCH_LLM_MODEL=gpt-4o-mini
```

Restart the service after changing env vars.

---

## Agency Integrations page

**Path:** Sign in as **admin** → **Admin** → **Integrations**.

- **ElevenLabs API key** — TTS for that agency’s AI replies.
- **ElevenLabs voice ID** — Voice from your ElevenLabs library.
- **AI dispatcher system prompt** — **Your agency’s** instructions: local 10-codes, unit/call sign format, tone, and radio policy. If this field is empty, the server uses `AI_DISPATCH_SYSTEM_PROMPT` from Railway.
- **Outbound webhook URL** — Optional HTTPS URL; safeT POSTs JSON when the AI dispatcher sends a reply.
- **License plate / VIN** — Shown as *Coming soon*; reserved for portal lookup features.

Secrets are stored per `agency_id` in Postgres (`agency_integrations`). The API never returns full secret values—only masked hints (e.g. `••••abcd` for keys, or character count for the multiline prompt).

---

## Per-channel AI dispatch

**Path:** Dispatch console → open a channel panel → **AI DISPATCH OFF / ON**.

- Stored in `channel_ai_dispatch` per `(agency_id, channel_name)`.
- Requires platform AI on (Railway), agency ElevenLabs configured, and a completed transcript after a unit transmission.
- AI traffic uses the platform `AI_DISPATCH_UNIT_ID` so the engine does not reply to its own transmissions.

---

## Flow (built-in dispatcher)

1. Unit transmits on a channel with **AI DISPATCH ON**.
2. Recording is transcribed (Whisper).
3. Server loads the **agency system prompt** (Integrations) or Railway default.
4. LLM generates a short reply → ElevenLabs TTS → injected on the channel via voice loopback.
5. Optional outbound webhook with transcript and reply text.

Server logs are tagged `[ai-dispatch]`.

---

## Database tables

- `agency_integrations` — `(agency_id, integration_key)` → value
- `channel_ai_dispatch` — `(agency_id, channel_name)` → `enabled`, `yields_to_units`

---

## Optional: 10-8 Alert Portal server

You do **not** need to send the old 10-8 dispatcher server repo for this to work. safeT now runs the dispatcher pipeline on the same platform. Share that code only if you want to match exact legacy regex rules, UI, or prompt wording from the old project.
