# SafeT SDR — Windows one-click launcher

Two files do everything. No commands to memorize.

### 1. First time only — double-click **`Setup SafeT SDR.cmd`**

It installs WSL2 + Ubuntu, the USB tool (usbipd), the decoder stack, clones the
repo, and seeds your config. It will:

- ask to run as Administrator — say **Yes**
- (first run) install Ubuntu and ask you to **reboot, create your Ubuntu
  username/password, then run Setup again** to finish
- ask for your **safeT-PTT git URL**
- at the end, open `config\system.json` for you to fill in: your **control-channel
  frequency**, **Icecast passwords**, and your **SafeT admin login**

### 2. Pick talkgroups in the SafeT console

**Bridges → Import from RadioReference** → paste your RadioReference export → tick
the talkgroups → **Create**. (You only do this when you want to change what you
monitor.)

### 3. Every time — double-click **`Start SafeT SDR.cmd`**

It auto-attaches your Nooelec, opens the tunnel, points your bridges at it, and
starts decoding. A window stays open with the live decoder log. **Close it (or
press Ctrl-C) to stop.** That's it.

> **Prefer a real `.exe` on your Desktop?** Double-click **`Build EXE.cmd`** once —
> it builds **`SafeT SDR.exe`** and adds a **"SafeT SDR" Desktop shortcut**. From
> then on, step 3 is just double-clicking that icon. (Details below.)

---

### Notes & troubleshooting

- **Plug the dongle in before** double-clicking Start.
- The launcher **auto-repoints** your bridges to the current tunnel URL each run,
  so you never have to touch the Stream base URL again after the first time.
- Self-hosting SafeT on this same PC? The launcher detects a `localhost`
  `safet.baseUrl` and skips the tunnel automatically (or pass `-Local`).
- "No RTL-SDR found" → replug and double-click Start again (USB must be
  re-attached after each replug/reboot — the launcher does this for you).
- Want a literal `.exe` icon on your Desktop? **Double-click `Build EXE.cmd`** once.
  It compiles the launcher into **`SafeT SDR.exe`** (with the SafeT icon, via
  [PS2EXE](https://github.com/MScholtes/PS2EXE)) and drops a **"SafeT SDR" shortcut
  on your Desktop**. After that, starting is just double-clicking that icon — no
  `.cmd`, no window to hunt for.

  > The exe is built on *your* machine rather than shipped in the repo — a
  > committed binary is opaque, antivirus-prone, and can't be reviewed. The build
  > is one double-click and embeds the same script, so it's identical in behavior.

These scripts automate the manual steps in [../WINDOWS.md](../WINDOWS.md) — if a
step fails, that guide is the fallback.
