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

### 3. Tell sdrtrunk which talkgroups to send

Each talkgroup you want on SafeT needs the **`SafeT` broadcast channel** set on
its alias. Two ways:

- **Easiest:** import the generated alias list. SafeT SDR writes
  `sdrtrunk/safet-aliases.xml` inside the project (open
  `\\wsl.localhost\Ubuntu\home\<you>\safeT-PTT\sdr-bridge\sdrtrunk\` from
  Windows Explorer). In sdrtrunk → **Playlist → Aliases → Import**, choosing
  your channel's alias list. It tags every SafeT-mapped OC CCCS talkgroup with
  the `SafeT` stream and a readable label.
- **Or by hand:** on each alias you already have, set **Broadcast Channel** =
  `SafeT`.

The bridge routes each uploaded call to its SafeT channel by talkgroup id (from
your SafeT **Bridges**), and sends every call to the **Scan All** channels.

### 4. Point SafeT SDR at sdrtrunk

In SafeT SDR → **Settings → Decoder**:

- **Decoder backend** → `sdrtrunk`
- **sdrtrunk folder** → the unzipped sdrtrunk folder (the one containing
  `bin\sdr-trunk.bat`)
- **Save**, then **Start**.

On Start, SafeT SDR detaches the dongle from WSL (so Windows/sdrtrunk owns it),
launches sdrtrunk, and runs the call-upload bridge. Stop closes both.

## Verifying

- sdrtrunk's **Streaming** tab shows the `SafeT` stream connected with a
  growing call/packet count.
- SafeT SDR's **Channels** panel shows calls arriving (`Sent` increments) a few
  seconds after each transmission ends.
- A call that decodes in sdrtrunk should arrive whole on SafeT with the
  talkgroup name on **Scan All**.

If sdrtrunk's stream shows errors, re-check the Host URL and that
`127.0.0.1:8765` is reachable from Windows (mirrored networking, or the WSL IP).
