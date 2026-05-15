# Railway + PostgreSQL + Android (step by step)

This guide assumes you already have the `radio-platform` repository on GitHub and you are signed into [Railway](https://railway.app/).

---

## Part A — Deploy the API to Railway

### A1. Create a Railway project

1. Go to [railway.app](https://railway.app/) and sign in.
2. Click **New Project**.
3. Choose **Deploy from GitHub repo** (or **Empty Project** if you prefer uploading later).
4. Select your **`radio-platform`** repository.

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

### A5. (Recommended) Set a shared API key

1. Open the API service → **Variables**.
2. Add **`RADIO_API_KEY`** with a long random string (example: 32+ characters).  
3. Redeploy if Railway does not auto-redeploy.

When `RADIO_API_KEY` is set, every request (except `GET /health`) must include header:

`X-Radio-Key: <the same value>`

The Android app sends this header when you set `radio.api.key` in `local.properties` (see Part B).

### A6. Assign a public HTTPS URL

1. Open the API service → **Settings** → **Networking**.
2. Under **Public Networking**, click **Generate Domain** (or attach a custom domain).

Copy the HTTPS URL, for example:

`https://your-service-name.up.railway.app/`

Keep the trailing slash out of your copy if you like; the Android Gradle snippet normalizes it.

### A7. Verify from your laptop browser

Open:

`https://your-service-name.up.railway.app/health`

You should see JSON like `{ "status": "ok", ... }`.

Then open:

`https://your-service-name.up.railway.app/v1/channels`

You should see:

```json
{ "channels": [ {"id":1,"name":"Green 1"}, {"id":2,"name":"Green 2"}, {"id":3,"name":"Green 3"} ] }
```

If you enabled `RADIO_API_KEY`, use a REST client (or `curl`) to add the header `X-Radio-Key`.

---

## Part B — Point the Android app at Railway

### B1. Locate `local.properties`

Android Studio creates **`android-app/local.properties`** (project root for the Gradle project, next to `settings.gradle.kts`).

This file is **not** committed to git (it is machine-specific).

### B2. Add your Railway URL and optional API key

Add these lines (use your real URL and key):

```properties
radio.api.base.url=https://your-service-name.up.railway.app/
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
  - **Release** builds default to a placeholder `https://CHANGE_ME.up.railway.app/` until you set the property.

For real devices on Wi‑Fi, you should **always** set `radio.api.base.url` to your Railway HTTPS URL.

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

| Symptom | What to check |
|--------|----------------|
| Android shows **OFFLINE** / fallback | Wrong `radio.api.base.url`, device offline, or server sleeping on free tier. Open `/health` in a browser. |
| **401 unauthorized** from `/v1/channels` | `RADIO_API_KEY` set on server but `radio.api.key` missing/wrong in `local.properties`. |
| Gradle can’t find `local.properties` | It must live in **`android-app/`** root (Gradle project root), not inside `app/`. |
| Postgres errors in Railway logs | Confirm **`DATABASE_URL`** is referenced on the API service variables. |

---

## Security notes (private enterprise)

- Treat `RADIO_API_KEY` like a shared password for now; later replace with per-device credentials.
- Prefer **HTTPS only** for production (Railway’s generated domain is HTTPS).
- Do **not** commit `local.properties` or real keys into git.
