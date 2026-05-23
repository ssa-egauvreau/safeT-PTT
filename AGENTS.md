# Repository workflow

## Git: use `main` only

- Put **all** changes on **`main`**: commit locally on `main`, then **`git push origin main`**.
- **Do not** create topic branches or open pull requests for this project unless the owner explicitly asks.
- **Android Studio:** stay on branch **`main`**. Use **Git → Pull** on `main`, then build and run. No branch switching required for normal updates.

## Cloud / automation agents

When applying changes in this repo, **commit and push to `main`** directly. Skip separate `cursor/...` feature branches and skip opening PRs unless the user overrides this file.

## Cursor Cloud specific instructions

### Architecture overview

This is a push-to-talk radio platform with three Node.js packages:

| Package | Path | Purpose |
|---------|------|---------|
| API Server | `server/` | Express + WebSocket backend (voice relay, REST API) |
| Web Console | `server/web-console/` | React + Vite SPA (dispatch/admin) |
| Desktop Shell | `desktop-console/` | Electron wrapper for the web console |

### Running locally

1. **API server:** `cd server && npm run dev` (starts `tsx watch` on port 8080)
2. **Web console:** `cd server/web-console && npm run dev` (Vite dev server on port 5173, proxies `/v1` to `:8080`)
3. Both can run without `DATABASE_URL` — the server falls back to in-memory defaults and radio endpoints work fine. Login/admin features require PostgreSQL.

### TypeScript checks

- Server: `cd server && npx tsc --noEmit`
- Web console: `cd server/web-console && npm run typecheck`

### Key caveats

- The server runs without a database (`DATABASE_URL` not set) and logs "database_unavailable" warnings — this is expected and non-fatal. Radio endpoints (channels, air, presence, talk-activity, voice WebSocket) still function.
- The Whisper transcription model and KB embedding model load asynchronously on first boot. If `TRANSCRIPTION=off` and `KB_ENABLED=off` are set, they are skipped entirely (faster startup for dev).
- The Vite dev server at `:5173` proxies all `/v1/*` and `/health` requests to the API server at `:8080`. Always start the API server first.
- The desktop-console (`desktop-console/`) is Electron and requires a display; skip it in headless Cloud Agent environments.
