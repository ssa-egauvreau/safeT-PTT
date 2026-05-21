# Integrations and AI dispatcher

safeT separates **who configures what**:

| Layer | Where | Examples |
|-------|--------|----------|
| **Platform (Railway env)** | Server operator | AI dispatcher on/off, LLM API key, model, **default** system prompt |
| **Per agency (Admin → Integrations)** | Each tenant’s admin | ElevenLabs API key & voice, **agency system prompt** (10-codes, call signs), outbound webhook |
| **Per channel (dispatch console)** | Channel panel | Turn AI dispatcher on/off per channel (like 10-33 marker) |

**10-8 Systems (CAD + webhook)** and **plate/VIN lookup** are configured per agency under **Admin → Integrations**, not Railway Variables. Railway is only for platform-wide AI (Anthropic/OpenAI) and optional global fallbacks (see below).

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
- **TTS model** — Server default `eleven_v3` (expressive; requires an ElevenLabs account with v3 API access — this deployment has it) with **Creative** stability (`0.0`). Optional Railway overrides: `ELEVENLABS_MODEL_ID`, `ELEVENLABS_STABILITY` (`0` Creative, `0.5` Natural, `1` Robust). If a key lacks v3 access the dispatcher goes silent — set `ELEVENLABS_MODEL_ID=eleven_turbo_v2_5` to fall back to the broadly-available real-time model.
- **TTS pronunciation** — Same pipeline as the old 10-8 dispatcher: radio codes (`913` → “nine thirteen”), SSA account codes (`32-08` → “thirty-two oh-eight”), command staff (`27-000` → “twenty seven thousand”), call types, phone digit groups, NATO plate phonetics, and SSML pacing breaks.
- **TTS precache** — On startup, common ack phrases from the old server (Copy, `{unit}, 913`, status acks, standby lines) are pre-generated per agency that has ElevenLabs configured, so short replies play instantly.
- **Web search (phone book)** — Phone numbers, contacts, external addresses (e.g. Garden Grove PD), legal codes, and general questions use the same Anthropic `web_search` tool as the old dispatcher. Requires Railway `AI_DISPATCH_LLM_API_KEY` (Anthropic) and `AI_DISPATCH_ENABLED=1`. The AI says “standby” first, then speaks the answer a few seconds later.
- **AI dispatcher system prompt** — **Your agency’s** instructions: local 10-codes, unit/call sign format, tone, and radio policy. If this field is empty, **Sunset Safety** agencies use the built-in prompt exported from the 10-8 AI dashboard; other agencies use `AI_DISPATCH_SYSTEM_PROMPT` from Railway.
- **Outbound webhook URL** — Optional HTTPS URL; safeT POSTs JSON when the AI dispatcher sends a reply.
- **Lookups** — PlateToVIN key, optional VIN (Auto.dev) key, default plate state.
- **Webhooks** — **10-8 webhook bearer token** (what 10-8 sends as `Authorization: Bearer …`).
- **10-8 CAD** — API key + secret, optional base URL, **live CAD writes** (`1` = post comments, `0` = shadow/log only).

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

## 10-8 Systems (three credentials from the old dispatcher)

Migrate from the **10-8 alert dashboard** Railway project into **Admin → Integrations** (not Railway):

| Old Railway variable | Integrations field | Purpose |
|---------------------|-------------------|---------|
| `WEBHOOK_SECRET` | **Webhooks** → 10-8 incident export bearer token | 10-8 **pushes** incidents to safeT |
| `TEN8_API_KEY` + `TEN8_API_SECRET` | **10-8 CAD API** → key + secret (v1.0.8) | **Reads** (pending calls, lookups) + **comments** on existing calls |
| `TEN8_NEW_INCIDENT_API_KEY` + `TEN8_NEW_INCIDENT_API_SECRET` | **10-8 New Incident API** → key + secret | **Creates** new CAD calls (Basic auth on `interface.10-8systems.com`) |
| `TEN8_API_BASE_URL` | 10-8 CAD API base URL (optional) | Override v1.0.8 gateway |
| `TEN8_NEW_INCIDENT_API_BASE_URL` | New Incident API base URL (optional) | Override create-call host |
| `live_execution_enabled` (UI toggle) | **10-8 live CAD writes** = `1` or `0` | `0` = shadow/log only; `1` = real writes |

### Incident export webhook

Point **10-8 Systems** incident export at:

`https://YOUR_SAFET_HOST/v1/webhooks/10-8?agency=YOUR_AGENCY_SLUG&token=YOUR_WEBHOOK_SECRET`

- **Auth:** the shared secret (`TEN8_WEBHOOK_SECRET` env, or `ten8_webhook_secret` in Integrations) may be sent **either** as `Authorization: Bearer …` **or**, when 10-8 can't set headers, as the `token=` (also accepts `secret=`/`key=`) query param shown above. In production a secret is required; unauthenticated posts get **401**.
- **Agency:** `agency` query must match your agency slug.

Active incidents appear on **Command → AI dispatch activity log**.

## Plate / VIN lookup

**Admin → Integrations → Lookups:**

- **License plate lookup API key** — PlateToVIN.com key (912 plate readbacks).
- **VIN lookup API key** — Auto.dev (optional; uses plate key if empty).
- **Default plate state** — e.g. `CA`.

Do **not** put plate keys in Railway for normal agency setup. Optional env fallbacks (`PLATE_LOOKUP_DEFAULT_STATE`, `PLATE_LOOKUP_PROVIDER`) exist for operators only; per-agency keys in Integrations take precedence.

## 10-8 CAD API and New Incident API

**10-8 CAD API (v1.0.8)** — `TEN8_API_KEY` / `TEN8_API_SECRET` from the old dispatcher:

- List/read incidents, post AI summary **comments** on the active webhook incident.
- **10-8 live CAD writes** — `1` to post for real; `0` for shadow mode (log only).

**10-8 New Incident API** — `TEN8_NEW_INCIDENT_API_KEY` / `TEN8_NEW_INCIDENT_API_SECRET`:

- Second key pair from 10-8 support; used only to **create** new calls (not reads/comments).
- If empty, safeT can fall back to the v1.0.8 key pair when creating calls (same as the old server).

## AI activity log

**Command → AI dispatch activity log** (or top nav **AI Log**): live feed of transcripts, intents, on-air replies, plate lookups, and 10-8 webhook state. Refreshes every 5 seconds.
