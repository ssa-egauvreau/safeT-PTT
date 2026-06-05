# Running this on Windows 11

trunk-recorder has no good native Windows build, and Docker-on-Windows can't
cleanly pass the USB dongle through or use host networking. So on Windows you run
the pipeline inside **WSL2** (a lightweight Ubuntu built into Windows) and hand
the Nooelec to it with **usbipd**. Everything else then works exactly as the main
[README](./README.md) describes — and there's a one-command launcher.

It looks like a lot of steps the first time, but **steps 1–3 are one-time setup**.
After that, day-to-day is: plug in dongle → attach it (1 command) → `run-all`.

---

## One-time setup

### 1. Install WSL2 + Ubuntu

In **PowerShell as Administrator**:

```powershell
wsl --install -d Ubuntu
```

Reboot if it asks, then open **Ubuntu** from the Start menu and set a username/password.

### 2. Turn on mirrored networking (makes localhost "just work")

So WSL and Windows share `localhost` in both directions (Icecast, SafeT, etc.),
create `C:\Users\<you>\.wslconfig` with:

```ini
[wsl2]
networkingMode=mirrored
```

Then in PowerShell: `wsl --shutdown` and reopen Ubuntu.

### 3. Install the tools inside Ubuntu (WSL)

In the **Ubuntu** terminal:

```bash
sudo apt update
sudo apt install -y rtl-sdr ffmpeg icecast2 docker.io nodejs git usbutils
# Let your user run docker without sudo (log out/in of WSL after this):
sudo usermod -aG docker "$USER"
```

When the `icecast2` installer asks to configure it, choose **No** — we use our own
generated config.

> **Why native `docker.io` and not Docker Desktop?** The bundled trunk-recorder
> container needs Linux **host networking** + the **USB device**, which the native
> WSL Docker engine gives you and Docker Desktop does not.

### 4. Install usbipd on Windows (shares the USB dongle into WSL)

In **PowerShell as Administrator**:

```powershell
winget install usbipd
```

---

## Every time you want to run it

### A. Attach the dongle to WSL

Plug in the Nooelec, then in **PowerShell as Administrator**:

```powershell
usbipd list
# find the Nooelec / "RTL2838" / "Bulk-In" line, note its BUSID (e.g. 2-4)
usbipd bind   --busid 2-4
usbipd attach --busid 2-4 --wsl
```

Confirm it landed in Ubuntu:

```bash
lsusb          # should list "Realtek ... RTL2838"
rtl_test       # should see the device; Ctrl-C to stop
```

> If `rtl_test` says the device is in use by a kernel driver, run:
> `echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf`
> then `usbipd detach`/`attach` again (or replug).

### B. First time only — get the code and configure

```bash
cd ~ && git clone <your safeT-PTT repo url>   # or: cd ~/safeT-PTT && git pull
cd safeT-PTT/sdr-bridge
git checkout claude/festive-bohr-Eknpx

cp config/system.example.json config/system.json
```

Edit `config/system.json` (use `nano config/system.json` or open the WSL folder in
VS Code). For the console workflow you only fill in: your **control-channel
frequency(ies)**, Icecast **passwords**, and your **SafeT admin login** — you do
**not** list talkgroups here (you pick those in the console). For OC CCCS (P25
Phase II) keep `modulation: "qpsk"` — there is no phase flag, trunk-recorder
auto-detects Phase II.

**If your SafeT is in the cloud (Railway)**, the cloud server can't see your PC's
Icecast, so expose it with a tunnel. Install cloudflared once in WSL:

```bash
sudo apt install -y cloudflared || \
  (curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
     -o /tmp/cf && sudo install /tmp/cf /usr/local/bin/cloudflared)
```

Run it in its own terminal and copy the URL it prints — that's your **Stream base
URL** for the console:

```bash
cloudflared tunnel --url http://127.0.0.1:8000
# -> https://random-words.trycloudflare.com
```

> ⚠️ A free quick-tunnel gets a **new URL every restart**. If you restart
> cloudflared, update the **Stream base URL** in the console (Bridges → Import)
> and re-create, or re-run `npm start`. For a permanent URL set up a
> [named Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
> (free, needs a domain on Cloudflare) — set once, never touch again.
>
> Self-hosting SafeT on this PC instead? No tunnel — use `http://127.0.0.1:8000`
> (mirrored networking from step 2 makes it reachable).

### C. Pick talkgroups in the SafeT console

In the SafeT console: **Bridges → Import from RadioReference**. Paste your
RadioReference talkgroup export (or upload the CSV), tick the talkgroups you want,
put your **Stream base URL** (the cloudflared URL above) in the box, and click
**Create**. Each talkgroup becomes a channel + bridge. Add/remove any time — it's
just clicking.

### D. Launch everything (one command)

```bash
sudo service docker start        # WSL doesn't auto-start the docker daemon
npm start                        # syncs your console talkgroups, then runs everything
```

`npm start` reads the bridges you just created, configures the decoder to match,
and starts Icecast + the streamers + trunk-recorder together. You'll see it lock
the control channel and log calls. Leave it running; **Ctrl-C stops everything.**
Changed your talkgroups in the console? Just re-run `npm start`.

### E. Verify

- **trunk-recorder** terminal: "Control Channel ... locked" then call logs.
- Browser → `http://127.0.0.1:8000/` : one mount per talkgroup (silent between
  calls is normal).
- SafeT console → **Bridges** tab: each meter flips to **keyed** on a live call.
- Open the channels on your handset/console — DSP-DSP, Air Call, JWA Silver 1,
  each on its own channel, all at once.

---

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| `lsusb` doesn't show the dongle | Re-run `usbipd attach --busid <id> --wsl` (re-attach is needed after every replug / reboot). |
| trunk-recorder never locks the control channel | Wrong `modulation` (try `fsk4`), wrong control freq, or low `gain` — edit `system.json`, `npm run generate`, relaunch. |
| `docker: permission denied` | You didn't log out/in after `usermod -aG docker`, or run `sudo service docker start`. |
| SafeT bridge stuck at level 0 | Server can't reach `serverReachableBase` — for cloud SafeT use the cloudflared tunnel URL. |
| Some simultaneous calls missing | Site channels span > ~2 MHz for one dongle — add a second Nooelec as another entry in `sources[]` (ask and I'll wire it). |

## Don't want WSL at all?

The only no-WSL Windows option is **SDRTrunk** (a native Java GUI that decodes P25
Phase II nicely). The catch: it streams to Broadcastify/RdioScanner, not to
per-talkgroup Icecast mounts, so feeding many separate channels into SafeT becomes
a manual virtual-audio-cable job and the auto-import here won't apply. For your
goal — many talkgroups → many SafeT channels, automatically — WSL2 + trunk-recorder
is the simpler path overall.
