# Railway + PostgreSQL + Android (step by step)

This guide assumes you already have the **`safeT-PTT`** repository on GitHub and you are signed into [Railway](https://railway.app/).

---

## Part A — Deploy the API to Railway

### A1. Create a Railway project

1. Go to [railway.app](https://railway.app/) and sign in.
2. Click **New Project**.
3. Choose **Deploy from GitHub repo** (or **Empty Project** if you prefer uploading later).
4. Select your **`safeT-PTT`** repository.

### A2. Add the Node service (the `server` folder)

1. In the Railway project canvas, click **New** → **GitHub Repo** (if not already linked) or **Service from repo**.
2. Select the same repository.
3. Open the new service → **Settings**.
4. Set **Root Directory** to: `server`  
   (This tells Railway to run commands inside the `server/` folder.)

### A3. Configure build and start commands

Still in the service **Settings**:

1. **Build Command**: `npm install && npm run build`
2. **Start Command**: `npm start`  
   (`npm start` runs `node dist/index.js` from `package.json`.)

Railway sets **`PORT`** automatically. The server already reads `process.env.PORT`.

### A4. Add PostgreSQL

1. In the Railway project, click **New** → **Database** → **PostgreSQL**.
2. Wait until the database shows as **Active**.
3. Railway automatically injects **`DATABASE_URL`** into services in the same project **when you link them**:
   - Open your **API service** → **Variables**.
   - Click **Add Variable** → **Add Reference** (or **Variable Reference**).
   - Choose the Postgres service → select **`DATABASE_URL`** → add.

After this, your API process will see `DATABASE_URL` and will create/seed the `radio_channels` table on boot.

### A5. (Optional) Simulate “someone else is transmitting”

1. On the API service → **Variables**, add **`AIR_OCCUPIED`** with value **`1`** (or **`true`**).
2. Redeploy. While PTT is held, the handset polls **`GET /v1/air`**; when `occupied` is true it plays the **`busy.wav`** loop instead of the talk-permit tone.

### A6. (Recommended) Set a shared API key

1. Open the API service → **Variables**.
2. Add **`RADIO_API_KEY`** with a long random string (example: 32+ characters).  
3. Redeploy if Railway does not auto-redeploy.

When `RADIO_API_KEY` is set, every request (except `GET /health`) must include header:

`X-Radio-Key: <the same value>`

The Android app sends this header when you set `radio.api.key` in `local.properties` (see Part B).

### A7. Assign a public HTTPS URL

1. Open the API service → **Settings** → **Networking**.
2. Under **Public Networking**, click **Generate Domain** (or attach a custom domain).

Copy the HTTPS URL. Production is:

`https://safet.up.railway.app/`

Keep the trailing slash out of your copy if you like; the Android Gradle snippet normalizes it.

### A8. Verify from your laptop browser

Open:

`https://safet.up.railway.app/health`

You should see JSON like `{ "status": "ok", ... }`.

Then open:

`https://safet.up.railway.app/v1/air`

You should see `{"occupied":false}` unless you set **`AIR_OCCUPIED=1`**.

Then open:

`https://safet.up.railway.app/v1/channels`

You should see:

```json
{ "channels": [ {"id":1,"name":"Green 1"}, {"id":2,"name":"Green 2"}, {"id":3,"name":"Green 3"} ] }
```

If you enabled `RADIO_API_KEY`, use a REST client (or `curl`) to add the header `X-Radio-Key`.

---

## A9 — Voice relay (WebSocket PCM)

The API also exposes a **voice bridge** used by Android for live half-duplex audio on the tuned channel:

- Path: **`/v1/voice/stream`**
- URL example: **`wss://safet.up.railway.app/v1/voice/stream`** (HTTPS base → **`wss://`**)
- Upgrade uses the **same optional** header **`X-Radio-Key`** as REST when `RADIO_API_KEY` is set.

Protocol:

1. First **text** frame: UTF-8 JSON **`{"type":"join","unit_id":"<ID>","channel":"<exact channel label>"}`** (must match your `/v1/channels` catalog names so all clients land in the same room).
2. Then **binary** frames: raw **PCM mono, 16-bit signed little-endian**, **16000 Hz** (mic capture chunk size varies; server forwards verbatim).

Railway counts this as traffic on your HTTP service — no extra addon. If audio fails silently, verify the deployment completed and that nothing blocks WebSockets (corporate proxies, etc.).
---

## Part B — Point the Android app at Railway

### B1. Locate `local.properties`

Android Studio creates **`android-app/local.properties`** (project root for the Gradle project, next to `settings.gradle.kts`).

This file is **not** committed to git (it is machine-specific).

### B2. Add your Railway URL and optional API key

Add these lines (use your real URL and key):

```properties
radio.api.base.url=https://safet.up.railway.app/
radio.api.key=YOUR_RAILWAY_RADIO_API_KEY
```

Rules:

- Include `https://`.
- A trailing `/` is optional; Gradle will normalize it.
- If you **omit** `radio.api.key`, the app will not send `X-Radio-Key` (only works if `RADIO_API_KEY` is unset on the server).

### B3. Sync Gradle and rebuild

1. **File → Sync Project with Gradle Files**
2. **Build → Rebuild Project**
3. Run the app on a **phone** or **emulator**.

### B4. Physical phone vs emulator defaults

- If you **do not** set `radio.api.base.url`:
  - **Debug** builds default to `http://10.0.2.2:8080/` (emulator only; points at your PC).
  - **Release** builds default to `https://safet.up.railway.app/` when the property is omitted.

If you omit `radio.api.base.url`, **debug and release builds** fall back to the production Railway host baked into `android-app/app/build.gradle.kts` (`https://safet.up.railway.app/`). Override that constant or use `local.properties` if you deploy a different backend.

---

## Part C — Microphone permission (PTT capture)

1. Install the app and open it.
2. In the **status strip**, tap **ALLOW MIC** and accept the system permission.
3. Hold **PTT** — the app starts an `AudioRecord` loop (audio is **not transmitted** yet; buffers are discarded while we build the media path).

---

## Part D — WAV sound cues

Add these files under:

`android-app/app/src/main/assets/sounds/`

- `channel_switch.wav`
- `ptt_permit.wav`
- `emergency.wav`

Rebuild after adding files.

---

## Troubleshooting

### Railway: “branch connected to production” / “GitHub repo not found”

This usually appears after renaming the GitHub repository (for example from `radio-platform` to **`safeT-PTT`**). Railway still points at the old name until you reconnect it.

1. Open [railway.app](https://railway.app/) → your **project** → click the **API service** (Node/`server` service).
2. Open **Settings** (gear).
3. Find **Source** / **Connect Repo** / **GitHub Repo**.
4. Click **Disconnect** (or **Change repository**).
5. Click **Connect Repo** (or **Connect GitHub**).
6. If GitHub asks, **authorize Railway** and allow access to **`ssa-egauvreau/safeT-PTT`**.
7. Select repository **`safeT-PTT`** (not the old `radio-platform` name).
8. Set **branch** to **`main`** (this repo uses `main`, not `master`).
9. Set **Root Directory** to **`server`**.
10. Confirm **Build Command**: `npm install && npm run build` and **Start Command**: `npm start`.
11. Save, then click **Deploy** / **Redeploy** once.

**Check variables did not disappear:** **Variables** tab → confirm **`DATABASE_URL`** is still linked to Postgres. Re-add **`RADIO_API_KEY`** if it was cleared.

**Verify:** open `https://safet.up.railway.app/health` after the deploy finishes (green/success in Railway).

If the repo does not appear in the list: GitHub → **Settings** → **Applications** → **Railway** → configure repository access → include **`safeT-PTT`**.

---

| Symptom | What to check |
|--------|----------------|
| Android shows **BUSY** while PTT even on Wi‑Fi | You are **OFFLINE** (no `ONLINE` in status), or **`AIR_OCCUPIED=1`** on the server, or `/v1/air` returns errors (treated as busy). |
| Android shows **OFFLINE** / fallback | Wrong `radio.api.base.url`, device offline, or server sleeping on free tier. Open `/health` in a browser. |
| **401 unauthorized** from `/v1/channels` | `RADIO_API_KEY` set on server but `radio.api.key` missing/wrong in `local.properties`. |
| Gradle can’t find `local.properties` | It must live in **`android-app/`** root (Gradle project root), not inside `app/`. |
| Postgres errors in Railway logs | Confirm **`DATABASE_URL`** is referenced on the API service variables. |

---

## Security notes (private enterprise)

- Treat `RADIO_API_KEY` like a shared password for now; later replace with per-device credentials.
- Prefer **HTTPS only** for production (Railway’s generated domain is HTTPS).
- Do **not** commit `local.properties` or real keys into git.
