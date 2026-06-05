# safeT Bridge (Windows desktop)

A dedicated, unattended desktop app whose **only** job is to run safeT PTT radio
bridges from the computer physically wired to an external radio or scanner.

It captures a line-in feed, VOX-gates it, and keys it onto a channel — and, for
bidirectional bridges, decodes the channel back out to a chosen speaker/line-out.

## Why a separate app (and not the web console)

The web dispatch console is **served by** the dispatch server. When the server
redeploys (e.g. a push to Railway) the console page itself reloads, tearing down
its JavaScript context and the live voice socket. That is the
"cannot connect to channel / I have to restart the audio button" symptom.

safeT Bridge loads its UI **locally** from the app itself, not from the server.
A server reboot therefore only drops the WebSocket — which the app reconnects on
its own with exponential backoff — and never reloads the app, never loses your
settings, and never needs the audio button restarted. Designed to run headless
on a bridge box for weeks.

### What makes it resilient

- **Local UI** — survives server reboots, redeploys, and network blips untouched.
- **Infinite auto-reconnect** — each bridge owns its own reconnect loop
  (1s → 20s backoff with jitter). The mic + audio graph stay open across
  reconnects, so a reconnect is silent and never re-prompts for the device.
- **Auto-login** — credentials are encrypted at rest with the Windows keychain
  (DPAPI via Electron `safeStorage`) and replayed automatically after a reboot.
- **Token self-heal** — a watchdog re-validates the session every 30s; if the
  token expires it re-authenticates and pushes the fresh token into the running
  bridges so they reconnect immediately.
- **Auto-resume** — bridges that were running when the box shut down come back up
  automatically on next launch.
- **Auto-start on Windows sign-in** — optional, on by default.

## Easy audio settings

Each bridge card exposes, with live feedback:

- **Input device** (line-in) and, for bidirectional bridges, **Output device**.
- **Input gain** (0.25×–6×, shown in dB) to bring a weak line-in up to level.
- **VOX sensitivity** (threshold) and **VOX hang** (tail), seeded from the
  server config and overridable per box.
- A **live input meter** with the VOX threshold marked, plus **TX**/**RX** lamps.

Overrides are stored on the box; "Reset audio settings" restores the server
defaults. Gain/VOX changes apply live to a running bridge without restarting it.

## Develop / run

Prerequisites: Node.js 18+ and npm.

```bash
cd bridge-console
npm install

# UI iteration in a plain browser (uses a localStorage shim for config):
npm run dev:renderer        # http://localhost:5173

# Typecheck the renderer:
npm run typecheck

# Build the renderer, then launch the Electron app:
npm start
```

> The Electron shell requires a display, so it cannot run in a headless CI box —
> build the renderer (`npm run build`) there instead.

## Build the Windows installer

```bash
cd bridge-console
npm install
npm run dist:win
```

The signed-by-you NSIS installer lands in `bridge-console/release/`. (`dist:mac`
and `dist:linux` targets exist for parity.) The renderer is built first, then
`electron-builder` packages `electron/` + `dist/`.

## Deploy a bridge box (click-by-click)

1. Run the installer from `release/` on the bridge computer; pick an install
   folder; let it launch when finished.
2. On first launch, enter:
   - **Username / Password** — an admin or dispatcher account for the agency
     (owner accounts cannot run bridges). The app already points at the
     `https://safet-ptt.com` dispatch server, so there is no address to type.
   - **Agency code** — only if your server requires it at login.
3. Leave **Stay signed in** and **Start automatically when Windows signs in**
   checked for a fully unattended box. Click **Sign in**.
4. For each bridge, pick the **Input device** wired to the radio/scanner. Speak
   (or feed audio) and adjust **Input gain** so the meter sits comfortably above
   the cyan **VOX threshold** marker on speech and below it on silence. For a
   bidirectional bridge, pick an **Output device** to monitor the channel.
5. Click **Start bridge**. The status reads **On the channel**. From now on the
   box recovers on its own from server reboots, network drops, and power cycles.

Bridges themselves (target channel, direction, yield behaviour, default VOX) are
configured by an admin under **Configure bridges** in the dispatch console; this
app runs the ones flagged as audio-device bridges for your agency.
