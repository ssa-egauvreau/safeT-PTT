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

## Verifying

- sdrtrunk's **Streaming** tab shows the `SafeT` stream connected with a
  growing call/packet count.
- SafeT SDR's **Channels** panel shows calls arriving (`Sent` increments) a few
  seconds after each transmission ends.
- A call that decodes in sdrtrunk should arrive whole on SafeT with the
  talkgroup name on **Scan All**.

If sdrtrunk's stream shows errors, re-check the Host URL and that
`127.0.0.1:8765` is reachable from Windows (mirrored networking, or the WSL IP).
