# Using sdrtrunk as the decoder (best for P25 simulcast)

Orange County CCCS Countywide is a **simulcast** P25 system: several towers
transmit the same signal at once, and they interfere at your antenna (LSM
distortion). The built-in decoder (trunk-recorder) is weak at this, so an
RTL-SDR struggles where a purpose-built scanner (e.g. a Uniden SDS200) sounds
perfect. **[sdrtrunk](https://github.com/DSheirer/sdrtrunk)** has a real
simulcast/LSM equalizer and decodes these systems cleanly from one dongle.

SafeT SDR can use sdrtrunk as the decoder instead of trunk-recorder. sdrtrunk
runs natively on **Windows** with the dongle (no WSL forwarding), decodes the
system, and uploads each **finished call** to a small receiver the SafeT
bridge runs. One call in = one complete SafeT transmission, with the real
talkgroup name — no partial audio, no silence gating.

> Trade-off: sdrtrunk streams a call only **after it finishes**, so SafeT is a
> few seconds behind a live scanner. You get the *whole* transmission,
> intelligibly — which is the thing that was broken before.

## One-time setup

### 1. Install sdrtrunk and get it decoding (you may already have this)

Download sdrtrunk, unzip it, and set up your tuner + a P25 channel for OC CCCS
as you normally would, until calls decode and play in sdrtrunk. SafeT SDR does
**not** touch your tuner/channel — that's the part that already works.

### 2. Add the SafeT stream in sdrtrunk

sdrtrunk → **Playlist → Streaming → New → RdioScanner**. Set:

| Field | Value |
|------|-------|
| Name | `SafeT` |
| Host / URL | `http://127.0.0.1:8765/api/call-upload` |
| API Key | `safet` (any non-empty value — the receiver doesn't check it) |
| System ID | `1` |
| Format | `MP3` |
| Enabled | ✓ |

(If WSL isn't using mirrored networking, use the WSL IP from `wsl hostname -I`
instead of `127.0.0.1`.)

### 3. Talkgroup aliases — automatic

Each talkgroup needs the **`SafeT` broadcast channel** set on its alias for
sdrtrunk to upload its calls. You don't have to do this by hand (newer sdrtrunk
builds don't even have an alias Import button): **every time you press Start,
SafeT SDR installs the full OC CCCS talkgroup list straight into your sdrtrunk
playlist** — names for every talkgroup, each tagged with the `SafeT` stream,
re-pointed at whatever alias list your channel already uses. Talkgroups you
already aliased are left untouched, and a `.safet-backup` copy of the playlist
is written first.

The bridge routes each uploaded call to its SafeT channel by talkgroup id (from
your SafeT **Bridges**), and sends every call to the **Scan All** channels.

> Order note: sdrtrunk must have run at least once (so a playlist file exists).
> If Start logs "no sdrtrunk playlist found yet", open sdrtrunk once, close it,
> and press Start again.

### 4. Point SafeT SDR at sdrtrunk

In SafeT SDR → **Settings → Decoder**:

- **Decoder backend** → `sdrtrunk`
- **sdrtrunk folder** → the unzipped sdrtrunk folder (the one containing
  `bin\sdr-trunk.bat`)
- **Save**, then **Start**.

On Start, SafeT SDR detaches the dongle from WSL (so Windows/sdrtrunk owns it),
launches sdrtrunk, and runs the call-upload bridge. Stop closes both.

## P25 Phase 2 (OC CCCS is Phase 2)

Nothing extra to configure. OC CCCS runs **P25 Phase 2 (TDMA)** voice on a
**Phase 1 (FDMA) control channel** — which is how every Phase 2 system works.
In sdrtrunk you still configure the channel as a trunked **P25 Phase 1**
decoder on the control channel; when the system grants a TDMA voice channel,
sdrtrunk creates the **P25 Phase 2** traffic-channel decoder automatically
(grab the scramble/randomizer parameters from the control channel too). The
Phase 2 vocoder (AMBE+2 half-rate, vs Phase 1's full-rate IMBE) is handled by
the same JMBE library that's already decoding your audio — if calls play in
sdrtrunk, Phase 2 audio is working.

The SafeT side never sees the vocoder at all: sdrtrunk uploads each call as an
already-decoded MP3, and the bridge ffmpeg-decodes that to PCM. Phase 1 and
Phase 2 calls arrive identically.

If specific talkgroups are silent while others work, check sdrtrunk's
**Traffic Channel Pool** size on the channel config (every concurrent call
needs a slot — Phase 2 carries two calls per frequency) and that you're on a
recent sdrtrunk (0.6.x) build, which has the current Phase 2 decoder fixes.

> **Whole areas missing (e.g. "OCSD Transit North", "Carbon Canyon",
> TAN-NORTH/SOUTH)?** That's not a talkgroup problem — OC CCCS is a **multi-site**
> system and sdrtrunk only follows **one site per channel config**. Those
> talkgroups ride sites you're not locked to. See
> **[CCCS-MULTISITE.md](./CCCS-MULTISITE.md)** for why, and how to configure a
> second site (North / Carbon Canyon) on your other dongle.

## Stability: stopping the every-few-hours OOM crash (v0.6.1)

The production rig froze every few hours: SDRTrunk's Java heap climbed to its
`-Xmx` cap and OOM-crashed, taking down the **whole** feed (Countywide
included). Two independent root causes, both diagnosed live:

### The 3-tuner cell layout

Three RTL-SDR dongles cover the OC CCCS system:

| Dongle | Role | Tuned block |
|--------|------|-------------|
| RTL #1 | **Countywide** control (856.7125 / 857.4625) | 856–860 MHz |
| RTL #2 | **853 MHz secondary-cell controls** — North, South, Carbon Canyon, Northwest, Southwest | ~852–853 MHz |
| E4000 | **Voice** — follows Countywide's TDMA grants | Countywide voice |

The secondary cells' **voice** grants come out on **~851 MHz**, which is
**outside every one of these three windows**.

### Root cause 1 — secondary-cell voice-chase thrash (config, fixable here)

The five 853-cell control channels shipped with
`traffic_channel_pool_size="20"`, so SDRTrunk tried to **follow** their voice
grants. Because that voice is out of band on all three dongles, SDRTrunk could
never source a tuner and looped
`Unable to source channel ... searching for another tuner` **hundreds of times
an hour**. That flooded the event-log buffer (grew to ~4 GB) and leaked the
heap straight to the `-Xmx` cap.

**Fix: run the secondary cells CONTROL-ONLY.** Set their
`traffic_channel_pool_size="0"`: SDRTrunk still decodes each control channel
(so talkgroup awareness / affiliation is preserved) but follows **zero** voice
grants — no chase, no thrash. **Countywide keeps its pool (30)** so it still
follows voice via the E4000.

**As of SafeT SDR v1.13.0 this runs automatically on every Start** (right
after the alias install, while sdrtrunk is closed), so a playlist edit or
sdrtrunk re-save can't quietly reintroduce the thrash — watch for
`[sdrtrunk] harden:` lines in the app log. It can still be run by hand
(idempotent, writes a timestamped `.bak`, preserves the file's encoding +
CRLF, and only touches enabled non-Countywide channels):

```bash
cd sdr-bridge
SDRTRUNK_PLAYLIST="C:\Users\<you>\SDRTrunk\playlist\OCCCCs.xml" npm run harden:sdrtrunk
# or pass the path: node scripts/sdrtrunk-harden-channels.mjs <playlist.xml>
```

After it runs, the 5 secondary controls read `traffic_channel_pool_size="0"`,
Countywide stays `30`, and the app log stops spamming
`Unable to source channel`. This is **separate** from the alias list — the
alias generator (`scripts/sdrtrunk-playlist.mjs`) only writes
`sdrtrunk/safet-aliases.xml` and never touches channels or tuners, so this
channel edit persists across alias regen.

### Root cause 2 — SDRTrunk v0.6.1 baseline heap leak (upstream)

Even with the thrash gone, SDRTrunk v0.6.1 **still slowly leaks** the heap
(~5–6 GB over several hours). There's no config fix for this in 0.6.1; mitigate
with a **periodic restart of just the SDRTrunk process**, which resets the
Java heap.

**As of SafeT SDR v1.13.0 the cadence restart is built into the app**: the
watchdog restarts sdrtrunk every **4 hours** by default
(`"sdrtrunkRestartHours"` in the app's settings.json; `0` disables), and it
launches sdrtrunk with `-XX:+ExitOnOutOfMemoryError` so a heap that *does* hit
the cap kills the process instantly — which the watchdog heals in ~15 s —
instead of leaving a frozen zombie. No Task Scheduler setup needed.

The scheduled task below is now an **optional backstop** for when the desktop
app itself isn't running:

- `scripts/restart-sdrtrunk.ps1` kills **only** the SDRTrunk `java` process
  (matched by its `*sdr-trunk-windows*` path — Blue Iris, CodeProject.AI, and
  any other Java are left untouched), waits ~60s for the SafeT SDR watchdog to
  relaunch it, and — if the desktop app isn't running to do that — **relaunches
  SDRTrunk itself** from the killed process's own install folder. Every outcome
  is appended to `Desktop\sdrtrunk-restart.log`, so a scheduled restart can
  never leave the feed dead.
- `scripts/install-sdrtrunk-restart-task.ps1` registers a Windows Task
  Scheduler job **"SDRTrunk Heap Restart"** that runs it **every 4 hours** at
  highest privileges. Copy `restart-sdrtrunk.ps1` to the Desktop first (the
  task points at `%USERPROFILE%\Desktop\restart-sdrtrunk.ps1`), then run the
  installer once from an elevated PowerShell. Re-copy + re-run after pulling a
  newer version of the script.

A ~4h cadence keeps the heap well under the cap between resets. Countywide
re-locks within seconds of each relaunch, so the outage per restart is a blip.

### Root cause 3 — freezes the process-check watchdog can't see

Before the heap finally OOMs, the JVM spends a long stretch in a **GC
death-spiral: the process is alive but decodes nothing**. SafeT SDR's watchdog
used to check only that the SDRTrunk process *exists*, so a frozen SDRTrunk
passed as healthy and the feed sat dead until someone RDP'd in (or the next
4-hour scheduled kill).

**Fix: the watchdog now watches CALL FLOW, not just the process.** The WSL
bridge stamps `lastCallUploadMs` into `/tmp/sdr-bridge-status.json` on every
call sdrtrunk uploads. If the SDRTrunk process is up, the bridge is alive, and
**no call has arrived for 15 minutes** (15 min of dead air on a countywide
public-safety system means a hung decoder, not a quiet system), the watchdog
kills and relaunches sdrtrunk automatically. Requires the SafeT SDR desktop
app running (it hosts the watchdog).

Tune it via the desktop app's `settings.json` (`%APPDATA%\safet-sdr\` →
`"sdrtrunkStallMinutes": 15`); set `0` to disable. After a stall restart the
watchdog waits one full window before it will stall-restart again, so genuinely
quiet air can't cause a restart loop.

### If it still goes down — checklist

1. **SafeT SDR is v1.13.0 or newer** (title bar / About; the app auto-updates
   from GitHub Releases — restart it once to apply a downloaded update). That
   build hardens the playlist on every Start, cadence-restarts sdrtrunk every
   4 h, restarts it when calls stall for 15 min, and launches it with
   `-XX:+ExitOnOutOfMemoryError`.
2. The **SafeT SDR desktop app is running** (it hosts every watchdog). Enable
   its auto-start-at-login setting so a Windows reboot brings everything back.
3. Optional backstop for when the app is closed: copy `restart-sdrtrunk.ps1`
   to the Desktop and run `install-sdrtrunk-restart-task.ps1` once (elevated).
   The current script relaunches SDRTrunk itself if no watchdog does.
4. Give the JVM headroom: in the sdrtrunk folder edit `bin\sdr-trunk.bat` (or
   SDRTrunk's User Preferences → JVM memory) and raise `-Xmx` if the box has
   RAM to spare — more headroom stretches the time between forced restarts.
5. Consider a newer sdrtrunk 0.6.x nightly — the v0.6.1 baseline leak is
   upstream, and later builds carry decoder/memory fixes.

## Verifying

- sdrtrunk's **Streaming** tab shows the `SafeT` stream connected with a
  growing call/packet count.
- SafeT SDR's **Channels** panel shows calls arriving (`Sent` increments) a few
  seconds after each transmission ends.
- A call that decodes in sdrtrunk should arrive whole on SafeT with the
  talkgroup name on **Scan All**.
- Handsets show the real talker while a call plays: the receive line reads
  `RX: <radio ID> • <talkgroup alias>` (e.g. `RX: 5921719 • TAN-CALL`), taken
  from the call metadata sdrtrunk uploads, and the Transmission Log attributes
  each call the same way.

If sdrtrunk's stream shows errors, re-check the Host URL and that
`127.0.0.1:8765` is reachable from Windows (mirrored networking, or the WSL IP).

For the stability fixes above:

- After `harden:sdrtrunk`, the 5 secondary controls show
  `traffic_channel_pool_size="0"` and Countywide stays `30`.
- The app log no longer spams `Unable to source channel`.
- SDRTrunk runs many hours without the heap hitting the `-Xmx` cap; the
  scheduled task restarts it on cadence (entries in
  `Desktop\sdrtrunk-restart.log`), Countywide keeps locking, and the SafeT
  stream stays **Connected** with 0 upload errors.
- If SDRTrunk ever hangs mid-window, the desktop log shows
  `[watchdog] sdrtrunk frozen? process up but no calls for N min — restarting
  it…` and calls resume within a minute or two — no RDP needed.
