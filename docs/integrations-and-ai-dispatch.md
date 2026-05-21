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
| `AI_DISPATCH_LLM_API_KEY` | For AI | **Anthropic:** paste your old `ANTHROPIC_API_KEY` here. **OpenAI:** use an OpenAI `sk-…` key instead. |
| `AI_DISPATCH_LLM_PROVIDER` | No | `anthropic` (default) or `openai` |
| `AI_DISPATCH_PROMPT_CACHE_TTL` | No | `1h` for Anthropic prompt caching (same as old 10-8 server). Use `5m` for shorter cache. |
| `AI_DISPATCH_LLM_BASE_URL` | OpenAI only | Default `https://api.openai.com/v1` — **leave unset for Anthropic** |
| `AI_DISPATCH_LLM_MODEL` | No | Anthropic default `claude-sonnet-4-6`; OpenAI default `gpt-4o-mini` |
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
- **AI dispatcher system prompt** — **Your agency’s** instructions: local 10-codes, unit/call sign format, tone, and radio policy. If this field is empty, **Sunset Safety** agencies use the built-in prompt exported from the 10-8 AI dashboard; other agencies use `AI_DISPATCH_SYSTEM_PROMPT` from Railway.
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
4. LLM returns structured JSON (same shape as 10-8): `dispatcher_response`, `trigger_emergency_tone`, intents, etc.
5. **10-33 / 10-34** — regex + AI turn the safeT **10-33 channel marker** on or off (DB flag + marker tone on the channel every 12s), not a browser-only sound.
6. ElevenLabs speaks `dispatcher_response` → voice loopback on the channel.
7. Optional outbound webhook with transcript and reply text.

Server logs are tagged `[ai-dispatch]`.

---

## Database tables

- `agency_integrations` — `(agency_id, integration_key)` → value
- `channel_ai_dispatch` — `(agency_id, channel_name)` → `enabled`, `yields_to_units`

---

## 10-8 CAD webhook (incident export)

Point **10-8 Systems** incident export at:

`https://YOUR_SAFET_HOST/v1/webhooks/10-8?agency=YOUR_AGENCY_SLUG`

- **Auth:** Bearer token — set `ten8_webhook_secret` under **Admin → Integrations → Webhooks**, or Railway `TEN8_WEBHOOK_SECRET`.
- **Agency:** `agency` query must match your agency slug (or set Railway `TEN8_WEBHOOK_AGENCY_SLUG`).

Active incidents appear on **Command → AI dispatch activity log**.

## Plate / VIN lookup

**Admin → Integrations → Lookups:**

- **License plate lookup API key** — PlateToVIN.com key (912 plate readbacks).
- **VIN lookup API key** — Auto.dev (optional; uses plate key if empty).
- **Default plate state** — e.g. `CA`.

## 10-8 CAD writes (optional)

**Admin → Integrations → 10-8 CAD:**

- API key + secret from 10-8 support.
- **10-8 live CAD writes** — set to `1` to post AI summary comments to the active incident; leave `0` for shadow mode (log only).

## AI activity log

**Command → AI dispatch activity log** (or top nav **AI Log**): live feed of transcripts, intents, on-air replies, plate lookups, and 10-8 webhook state. Refreshes every 5 seconds.
