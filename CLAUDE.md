# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**safeT PTT** is a private, multi-tenant enterprise push-to-talk platform for public safety. The Android handset (`android-app/`) is the primary client and is styled to feel like a Motorola APX radio without copying branded assets; iOS and a Windows/desktop console come later. Everything is a single GitHub monorepo. Production runs at `https://safet-ptt.com/` on Railway (Node API + PostgreSQL).

## Repository layout (the big picture)

Each top-level folder is an independent deployable surface. They share no build system — each has its own `package.json` / Gradle / Xcode project.

| Path | Surface | Stack |
|------|---------|-------|
| `server/` | API server — voice relay, REST API, recording, AI dispatch | Node + Express + `ws`, TypeScript (ESM) |
| `server/web-console/` | "safeT Command" dispatch console + "safeT Control" (agency admin) + "safeT Platform" (owner portal), all in one SPA | React 18 + Vite + react-router |
| `android-app/` | "safeT Mobile" handset | Kotlin + Jetpack Compose |
| `ios-app/` | iOS handset (later) | Swift + XcodeGen (`project.yml`) |
| `desktop-console/` | Electron shell that loads the hosted web console | Electron |
| `bridge-console/` | Standalone unattended Windows app that runs radio *bridges* locally (survives server redeploys) | Electron + Vite renderer |
| `sdr-bridge/` | Tooling to turn one RTL-SDR + trunk-recorder into many per-talkgroup streams that feed SafeT channels | Node scripts + Docker |
| `docs/` | Setup guides, runbooks, product backlog | Markdown |
| `brand/` | Brand assets | — |

The web console is built and **served by the API server** (`server/scripts/copy-server-assets.mjs` plus the web-console Vite build run from `server`'s `build` script). `desktop-console/` is just an Electron wrapper around the hosted console, which is why `bridge-console/` exists separately: it loads its UI locally so a server redeploy never tears down a running bridge.

## Common commands

### API server (`server/`)
```bash
cd server
npm run dev          # tsx watch on :8080
npx tsc --noEmit     # typecheck
npm test             # node --test over tests/**/*.test.ts
node --import tsx --test tests/auth.test.ts   # run a single test file
npm run build        # tsc + copy assets + build web-console into dist
npm start            # run built dist/index.js
```
Tests use the built-in `node:test` runner (no Jest/Vitest). Test files live in `server/tests/` mirroring `server/src/`.

### Web console (`server/web-console/`)
```bash
cd server/web-console
npm run dev          # Vite on :5173, proxies /v1/* and /health to :8080
npm run typecheck    # tsc --noEmit
npm run build        # vite build
```
**Always start the API server first** — the Vite dev server proxies all `/v1/*` and `/health` to `:8080`.

### Android (`android-app/`)
Requires the `codec2` and `opus` git submodules and an Android SDK with platform 35, build-tools 35.0.0, CMake 3.22.1, and an NDK. App config: `applicationId com.securityradio.ptt`, `minSdk 21`, `compileSdk`/`targetSdk 35`. Source package is `com.securityradio.ptt` (note: package name predates the "safeT" branding).
```bash
git submodule update --init --recursive
cd android-app && ./gradlew assembleDebug
```

### iOS (`ios-app/`)
Project is generated, not committed. **After every `git pull`** re-run submodules + `./setup.sh` (which runs `xcodegen generate`) — do not rely on Xcode's Clean Build Folder. See `ios-app/README.md` and `docs/ios-xcode-after-pull.md`.

### Electron apps
`desktop-console/` and `bridge-console/` use `npm start` / `npm run dist:win` (electron-builder). They need a display — skip them in headless environments.

## Architecture notes

### Server
- `index.ts` — boot: Express setup, security headers, schema init, recorder, codecs, voice relay attach, AI dispatch engine, background sweeps.
- `apiRoutes.ts` (very large) — the REST surface. `voiceRelay.ts` (very large) — the WebSocket voice path at `VOICE_WS_PATH`, kept outside Express/compression.
- `store.ts` + `db.ts` — domain state and PostgreSQL access. **The server runs without a database**: with `DATABASE_URL` unset it falls back to in-memory defaults and logs `database_unavailable` warnings (expected, non-fatal). Radio endpoints (channels, air, presence, talk-activity, voice WS) work; login/admin/multi-tenant features require PostgreSQL.
- Codecs: `codec2ServerCodec.ts`, `opusServerCodec.ts`, `imbeServerCodec.ts` (P25 IMBE vocoder, mirrored in clients), selected via `voiceCodecs.ts`.
- `aiDispatch/` — the AI dispatcher: `engine.ts`, intent `parse.ts`, `llm.ts`, `knowledgeBase/` (embeddings + retrieval), `speech`/TTS, plate/CAD lookups. Loads ML models (Whisper transcription, KB embeddings) asynchronously on first boot.
- `ten8/` — Ten-8 CAD integration (incidents, vehicles, geocoding, webhooks).
- `integrations/` + `bridgeWorker.ts` — outbound integrations and the server-side `ffmpeg` bridge that ingests stream URLs into channels.

### Multi-tenancy (read before touching auth/data)
Every account, channel, recording, alert, and handset belongs to an **agency**. A platform `owner` provisions agencies; each agency `admin` manages it. Legacy single-tenant data migrates into a "Default Agency" on first boot. Handsets authenticate with a per-agency radio key; the legacy global `RADIO_API_KEY` maps to the Default Agency. Console/admin/owner use per-account JWTs. When adding data or endpoints, scope them to an agency.

### Android (enforced conventions from README)
Keep UI / ViewModel / domain / data / device layers separate; state-driven Compose with hoisted, immutable UI state and explicit events. Hardware key mapping lives in the `device/` layer; transmit/audio lifecycle in a foreground service. Naming: `RadioUiState`, `RadioUiEvent`, `RadioViewModel`, `RadioScreen`, `RadioShell`. Keep the backend platform-neutral for future iOS/Windows clients.

## Git workflow

`AGENTS.md` is the repo's standing rule: **commit and push directly to `main`; do not create topic branches or open PRs unless the owner asks.** (Note: an individual Claude Code session may be assigned a specific working branch by its harness instructions — follow that when given, otherwise default to `main` per `AGENTS.md`.)

## Key environment variables

- `DATABASE_URL` — PostgreSQL. Unset → in-memory mode (see above). In cloud dev, if it's inherited pointing at `postgres.railway.internal` and that host is unreachable, **unset it** before local startup or background DB tasks crash the server after boot.
- `RADIO_API_KEY` — handset key for the Default Agency. `JWT_SECRET` — console/admin auth.
- `TRANSCRIPTION=off` and `KB_ENABLED=off` — skip Whisper + KB embedding model loads for faster dev startup.
- `TRANSCRIPTION_WORKERS` — size of the Whisper transcription pool (separate child processes, not threads — onnxruntime-node is not isolate-safe across worker_threads). Defaults to the container's CPU allotment capped at 3; raise on a bigger box. `TRANSCRIBE_BRIDGE=on` re-enables transcription of SDR/radio-bridge audio (off by default — it's a firehose). `TRANSCRIPTION_STALE_MS` reaps pending rows older than 30 min so the console never shows a permanent "Transcribing…".
- **Cloud transcription fallback** — on small Railway boxes local Whisper can OOM, leaving clips "failed" so the AI dispatcher never sees them. Set `TRANSCRIBE_CLOUD_API_KEY` (or reuse `OPENAI_API_KEY`) to enable an OpenAI Whisper API fallback: when the local pool returns nothing — or can't even spawn (OOM crash-cooldown) — the clip is transcribed in the cloud instead. Auto-enabled whenever a key is present; force off with `TRANSCRIBE_CLOUD_FALLBACK=off`. Setting `TRANSCRIPTION=off` **with** a cloud key configured runs cloud-only (no local model loaded at all — the lowest-memory mode). `TRANSCRIBE_CLOUD_MODEL` (default `whisper-1`), `TRANSCRIBE_CLOUD_URL`, and `TRANSCRIBE_CLOUD_CONCURRENCY` (default 2) tune it.
- `MODEL_CACHE_DIR` — persistent directory for the downloaded transformers.js models (Whisper + KB embeddings). Defaults to `$RAILWAY_VOLUME_MOUNT_PATH/model-cache` when a Railway volume is attached, else the ephemeral default (models re-download every boot). Point it at a persistent volume in production so the ~100 MB Whisper model loads from disk instead of re-downloading on each deploy.
- `AI_DISPATCH_LLM_*`, `ELEVENLABS_*`, `GOOGLE_MAPS_GEOCODING_API_KEY`, `PLATE_LOOKUP_*` — AI dispatch LLM, TTS, geocoding, and plate-lookup providers.
- `OWNER_USERNAME` / `OWNER_INITIAL_PASSWORD` / `ADMIN_INITIAL_PASSWORD` — seed accounts on first boot.
- Railway needs `ffmpeg` (declared in `server/railpack.json`) for bridge ingestion and recording.

## Working style (from README)

Give complete, copy-paste-ready files when generating code, and click-by-click steps for instructions. If a feature isn't implemented yet, create a minimal mock first. Do not copy Motorola branding or assets.
