# SafeT SDR — desktop control panel

A double-click Windows app that runs the whole RTL-SDR → SafeT pipeline for you:
no PowerShell, no Ubuntu terminal, no editing JSON.

- **Start / Stop** button — attaches the dongle and runs the decoder + streaming.
- **Live status** — dongle attached, control-channel locked, streaming mounts up,
  cloud tunnel running.
- **Settings form** — radio tuning, Icecast passwords, SafeT login. No JSON.
- **Auto-start on login** — set it once and forget it.
- **Logs** tab — watch the decoder in real time.

It's an Electron app that drives WSL/usbipd behind the scenes, reusing the exact
commands the `sdr-bridge` pipeline already uses.

## Prerequisites (one-time, you've already done these)

- WSL2 + Ubuntu, the `safeT-PTT` repo cloned at `~/safeT-PTT`
- `usbipd-win`, `cloudflared` Windows service, Docker in WSL
  (all handled by `windows/Setup-SafeT-SDR.ps1`)

If you haven't run Setup yet, run `windows/Setup SafeT SDR.cmd` first.

## Versioning

Bump `version` in `package.json` with **every** change to this app, and the UI
shows it next to the logo. That's how an operator tells whether a rebuild
actually picked up new code — the installer filename (`SafeT SDR Setup
<version>.exe`) and the top bar must both move.

## Build the app (one time)

The app source lives in WSL with the rest of the repo. Building produces a normal
Windows installer you then double-click.

### Easiest: double-click the builder

Open `\\wsl.localhost\Ubuntu\home\<you>\safeT-PTT\sdr-bridge\desktop\` in File
Explorer and double-click **`Build SafeT SDR.cmd`**. It installs the build tools
(first run downloads Electron, a few minutes), builds the installer, and opens the
`dist` folder. Run the `SafeT SDR Setup 1.0.0.exe` it produces.

### Or build by hand

In Ubuntu:

```bash
cd ~/safeT-PTT/sdr-bridge/desktop
sudo apt-get install -y wine64 || sudo apt-get install -y wine   # needed to build a Windows installer from Linux
npm install
npm run dist        # -> dist/SafeT SDR Setup 1.0.0.exe
```

(Prefer building on Windows? Install Node for Windows, then run `npm install` and
`npm run dist` from the `desktop` folder via `\\wsl.localhost\...` — no wine needed.)

## Install & use

1. Run the generated **`SafeT SDR Setup 1.0.0.exe`** → installs with a desktop +
   Start-menu icon.
2. Double-click **SafeT SDR**.
3. **Settings** tab → fill in radio settings, Icecast passwords, SafeT login → **Save**.
   Tick **Start automatically when I log in** if you want it hands-off.
4. **Dashboard** tab → **Start**. Approve the one admin prompt (to attach the dongle).
5. Watch the status cards go green. Use **Open SafeT console** to manage talkgroups.

## How it maps to the old manual steps

| You used to… | Now |
| --- | --- |
| `usbipd attach --wsl --busid …` in PowerShell (admin) | Start button (one UAC prompt; finds the dongle by hardware id) |
| `npm start` in Ubuntu | Start button |
| Edit `config/system.json` in nano | Settings form |
| `Ctrl-C` to stop | Stop button (also cleans up Icecast/ffmpeg) |
| Re-attach the dongle after every reboot | Auto-start on login (scheduled task) |

## Notes & troubleshooting

- **"Attach failed — try a different USB port"**: two USB devices landed on the same
  bus id (a Windows quirk). Move the dongle to another port and press Start again.
- **Radio setting changes** take effect on the next **Stop → Start**.
- The app keeps running in the **system tray** when you close the window, so streaming
  continues. Use the tray menu's **Quit** to stop it for real.
- It does **not** manage your `cloudflared` tunnel — that's your permanent Windows
  service (`sdr.safet-ptt.com`). The dashboard just shows whether it's running.
