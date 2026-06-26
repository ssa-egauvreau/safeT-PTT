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
`dist` folder. Run the `SafeT SDR Setup <version>.exe` it produces (the
`<version>` matches `package.json` — currently 1.12.0).

### Or build by hand

In Ubuntu:

```bash
cd ~/safeT-PTT/sdr-bridge/desktop
sudo apt-get install -y wine64 || sudo apt-get install -y wine   # needed to build a Windows installer from Linux
npm install
npm run dist        # -> dist/SafeT SDR Setup <version>.exe
```

(Prefer building on Windows? Install Node for Windows, then run `npm install` and
`npm run dist` from the `desktop` folder via `\\wsl.localhost\...` — no wine needed.)

## Install & use

1. Run the generated **`SafeT SDR Setup <version>.exe`** (from the `dist` folder) →
   installs with a Desktop + Start-menu icon.
   > **You must run the installer.** Launching via `npm start` / `electron .` or
   > from `dist\win-unpacked` is *not* the installed app — its taskbar entry has
   > no stable identity and won't pin properly. Always install the Setup `.exe`.
2. **Pin it to the taskbar:** open the Start menu, find **SafeT SDR**, right-click →
   **Pin to taskbar** (or **More → Pin to taskbar**). Now it's one click — no
   folders, no commands. (If you had pinned an older dev build, unpin it first so
   the pin points at the freshly installed app.)
3. Launch **SafeT SDR**.
4. **Settings** tab → fill in radio settings, Icecast passwords, SafeT login → **Save**.
   Tick **Start automatically when I log in** if you want it hands-off.
5. **Dashboard** tab → **Start**. Approve the one admin prompt (to attach the dongle).
6. Watch the status cards go green. Use **Open SafeT console** to manage talkgroups.

## Updating the app

Once a build with auto-update is installed, the app keeps itself current: it
checks for updates at launch and every 6 hours, **silently downloads** a newer
version in the background, and installs it the next time you quit (or click
**Restart now** when the "update ready" prompt appears). The **⟳ Updates** button
in the top bar checks on demand. If the update server is unreachable, the app
just keeps running on its current version — updates never block startup.

**How releases are published (one-time setup).** Auto-update pulls from a
separate, **public** binaries-only GitHub repo so the main `safeT-PTT` repo can
stay private without baking any token into the app:

1. Create a public repo for releases — default name `ssa-egauvreau/safet-sdr-releases`
   (to use a different name, change the `publish:` block in `electron-builder.yml`).
2. In the `safeT-PTT` repo settings, add a secret **`RELEASES_TOKEN`** = a GitHub
   PAT with **Contents: read/write** on that releases repo (the default
   `GITHUB_TOKEN` can't push to a different repo).

**Shipping a new version:**

1. Make your changes, bump `version` in `package.json` (the UI shows it next to
   the logo — that's how you confirm a client picked up new code).
2. Commit, then push a tag: `git tag sdr-desktop-v1.12.0 && git push origin sdr-desktop-v1.12.0`.
3. The **Release SafeT SDR Desktop** GitHub Action builds the Windows installer
   and publishes `SafeT SDR Setup <version>.exe` + `latest.yml` to the releases
   repo. Installed clients pick it up within ~6 hours (or immediately via **⟳ Updates**).

> **First time only:** auto-update activates for versions published *after* the
> first auto-update-capable build is installed. Install **1.12.0** manually once
> (build it, or download it from the releases repo); every version after that
> updates itself.
>
> **Code signing / SmartScreen:** the installer is unsigned, so Windows
> SmartScreen shows an "unknown publisher" prompt on first install and may
> reappear on each update (click **More info → Run anyway**). This is expected for
> an internal app. To silence it, sign the build (e.g. Azure Trusted Signing) by
> setting `CSC_LINK`/`CSC_KEY_PASSWORD` in the release workflow.

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
