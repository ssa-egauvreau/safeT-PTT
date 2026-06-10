# SDR → SafeT-PTT multi-channel bridge

Turn **one RTL-SDR** (your Nooelec NESDR v5) tracking a **P25 trunked system**
(e.g. Orange County CCCS) into **many simultaneous, separately-listenable
channels** in SafeT-PTT — one channel per talkgroup (DSP-DSP, Air Call, John
Wayne Silver 1, …).

## Why this exists (the gap it fills)

SafeT-PTT has **no SDR or trunking support** of its own. A SafeT *bridge* can
only ingest:

- a **stream URL** (Icecast / HLS / MP3) — decoded server-side by `ffmpeg`
  (`server/src/bridgeWorker.ts`), or
- an **audio device** — captured by the desktop console.

So the dongle can't feed SafeT directly. A P25 *trunked* system also doesn't map
talkgroups to fixed frequencies — they hop across the system's voice channels
under control-channel direction. To follow **several talkgroups at once** you
need a decoder that tracks the whole system and emits **one audio stream per
talkgroup**. That decoder is **trunk-recorder**, and this folder wires it to
SafeT:

```
 Nooelec v5 ──RF──► trunk-recorder ──UDP PCM per talkgroup──► ffmpeg ──► Icecast
                    (decodes OC CCCS)                         (1 per TG)   (1 mount per TG)
                                                                              │ HTTP
                                                                              ▼
   SafeT channel  ◄── SafeT "stream_url" bridge (VOX-gated) ◄── server ffmpeg pulls mount
```

Each talkgroup = one Icecast mount = one SafeT bridge = one SafeT channel you can
monitor at the same time as all the others.

## Simulcast systems? Use the sdrtrunk decoder

For **P25 simulcast** systems (e.g. OC CCCS Countywide), the built-in
trunk-recorder decoder struggles with multi-tower LSM distortion and audio
comes through choppy. SafeT SDR can instead drive **[sdrtrunk](https://github.com/DSheirer/sdrtrunk)**,
whose simulcast equalizer decodes these cleanly from a single dongle — set
**Settings → Decoder → sdrtrunk**. See **[SDRTRUNK.md](./SDRTRUNK.md)** for the
one-time setup. The rest of this README covers the built-in trunk-recorder path.

## ⚠️ The one hardware limit: RF bandwidth

Your single Nooelec v5 captures only **~2.4 MHz at once (~2.0 MHz reliable)**.
trunk-recorder can only record **simultaneous** calls whose voice frequencies all
fall inside that one window.

- If the OC site's voice channels are **clustered within ~2 MHz**, one dongle
  follows several talkgroups fine.
- If they're **spread wider**, one dongle will miss some simultaneous calls. The
  fix is more dongles — trunk-recorder happily uses several SDR `sources`
  (add entries to `sources[]` and split the talkgroups). Nooelec dongles are
  cheap; 2–3 covers most county systems.

Pull the site's **control channel** and **voice-channel frequency spread** from
your RadioReference export to know which case you're in.

---

## Two ways to pick talkgroups

**A) From the SafeT console (recommended, no JSON editing).** In the console go to
**Bridges → Import from RadioReference**, paste your RadioReference talkgroup
export, tick the talkgroups you want, set the **Stream base URL** (your Icecast /
tunnel address), and click **Create**. Each becomes a channel + bridge. On the PC
you then run **`npm start`**, which reads those bridges back from SafeT and decodes
exactly the talkgroups you picked — nothing to keep in sync. Add or remove
talkgroups any time in the console and re-run `npm start`.

**B) Offline, from a file.** List the talkgroups in `config/system.json`'s
`bridges[]`, run `npm run generate`, then `npm run import-bridges` to push the
channels/bridges up to SafeT. Useful with no console handy.

Both paths use the same convention: each stream lives at `…/tg<TalkgroupID>`, which
is how the PC launcher maps a bridge back to the talkgroup it should decode.

## What's in here

| Path | What it is |
|------|------------|
| `config/system.example.json` | Copy to `config/system.json`. Holds your RF, Icecast, and SafeT settings (talkgroups optional — only for path B). |
| `config/talkgroups.example.csv` | trunk-recorder talkgroup CSV (path B / offline validation). |
| `scripts/sync-from-safet.mjs` | **Path A:** reads the bridges you made in the console and regenerates the runtime files. (`npm run sync`) |
| `scripts/run-all.sh` | One command: sync, then start Icecast + streamers + trunk-recorder. (`npm start`) |
| `scripts/generate.mjs` | **Path B:** builds the runtime files + a bridge manifest from `system.json`. |
| `scripts/import-bridges.mjs` | **Path B:** pushes the manifest's channels + bridges to SafeT. Idempotent. |
| `docker-compose.yml` | Runs trunk-recorder (host-networked) against the USB dongle. |
| `trunk-recorder/config.template.json` | Annotated reference of the generated config. |

Generated files (`trunk-recorder/config.json`, `icecast/icecast.xml`,
`generated/`) and your real `config/system.json` are git-ignored — they hold
passwords and credentials.

---

## Prerequisites

> **On Windows 11?** Follow **[WINDOWS.md](./WINDOWS.md)** instead — it wraps all
> of this in WSL2 (with the dongle shared via usbipd) and a one-command launcher.
> The rest of this README still applies as background.

On the PC with the dongle plugged in (the same PC where you have the SafeT
**Bridges** tab open):

- **Node 18+** (to run the two scripts — uses built-in `fetch`, no `npm install`).
- **trunk-recorder** — via the included `docker-compose.yml` (easiest on Linux),
  or [built natively](https://trunkrecorder.com/docs/). Needs the **simplestream
  plugin** (bundled in the `robotastic/trunk-recorder` image).
- **Icecast** — `apt install icecast2` / `brew install icecast` /
  `choco install icecast`. Uses the `icecast/icecast.xml` we generate.
- **ffmpeg** — `apt install ffmpeg` (also what SafeT itself uses).
- **RTL-SDR drivers** — `rtl-sdr` package; confirm the dongle with `rtl_test`.

---

## Setup (recommended console workflow — path A)

### 1. Fill in the PC config (RF + Icecast + SafeT login — no talkgroups)

```bash
cd sdr-bridge
cp config/system.example.json config/system.json
```

Edit `config/system.json` — for path A you only need these (leave `bridges[]` alone):

- **`system.controlChannelsHz`** + **`system.modulation`** — from RadioReference
  for the OC CCCS site. Phase I vs Phase II is auto-detected per call (no flag);
  `modulation` is the *control-channel* modulation — `qpsk` for CQPSK/LSM
  simulcast (typical P25 Phase II county systems), `fsk4` for C4FM.
- **`sdr.centerHz` / `sdr.rateHz` / `sdr.gain` / `sdr.ppm`** — center the
  ~2 MHz window over the site's voice channels; `gain: 0` is auto to start.
- **`icecast.sourcePassword` / `adminPassword`** — pick passwords.
- **`safet`** — your SafeT `baseUrl` (ends in `/v1`) + an **admin** login (used to
  read back the bridges you create in the console).

### 2. Pick talkgroups in the console

SafeT console → **Bridges → Import from RadioReference** → paste your export →
tick talkgroups → set **Stream base URL** (your Icecast address; for cloud SafeT
that's your cloudflared tunnel URL) → **Create**. Done — channels + bridges exist.

### 3. Start everything on the PC (one command)

```bash
npm start          # = sync from SafeT, then launch Icecast + streamers + trunk-recorder
```

That's the whole loop. To change which talkgroups you monitor, edit them in the
console and re-run `npm start`. **The rest of this page (path B / "generate") is the
offline alternative — skip it if you're using the console.**

---

## Offline alternative (path B)

### 1. Fill in your config

```bash
cd sdr-bridge
cp config/system.example.json config/system.json
# Put your RadioReference talkgroup export here (trunk-recorder CSV format):
cp /path/to/your/export.csv config/talkgroups.csv
```

Edit `config/system.json` as above, plus:

- **`icecast.serverReachableBase`** — *the URL the SafeT **server** uses to reach
  Icecast* (see [Local vs cloud](#local-safet-vs-cloud-safet) below).
- **`bridges[]`** — one entry per talkgroup. `tgid` is the decimal Talkgroup ID;
  `channel` is the SafeT channel name; `mount` is a unique Icecast mountpoint
  (use `tg<TGID>`, e.g. `tg16`, to match the console convention).

### 2. Generate everything

```bash
npm run generate
```

Writes `trunk-recorder/config.json`, `icecast/icecast.xml`,
`generated/stream-talkgroups.sh`, and `generated/bridges.json`. Re-run any time
you change `system.json`.

### 3. Run it

**One command** starts Icecast + the streamers + trunk-recorder together
(Ctrl-C stops all):

```bash
bash scripts/run-all.sh
```

Then, in another terminal, create the SafeT channels + bridges:

```bash
npm run import-bridges       # add --dry-run first to preview
```

<details><summary>Prefer to run the pieces by hand?</summary>

```bash
icecast2 -c icecast/icecast.xml     # 1) Icecast
bash generated/stream-talkgroups.sh # 2) per-talkgroup ffmpeg streamers
docker compose up                   # 3) trunk-recorder
npm run import-bridges              # 4) SafeT channels + bridges
```

Order matters slightly: Icecast, then streamers (they publish empty mounts), then
trunk-recorder (it fills the UDP ports during calls). `import-bridges` can run any
time once SafeT is reachable.
</details>

### 4. Verify

- Browse `http://127.0.0.1:8000/` (Icecast status) — you should see one mount per
  talkgroup, streaming continuously (silence between calls — that's expected; the
  silence keepalive keeps the mount up so SafeT's pull stays connected).
- In the SafeT console **Bridges** tab, each bridge shows a level meter and flips
  to **keyed** when a call comes through on that talkgroup.
- Open the matching channels in your handset/console and you'll hear each
  talkgroup on its own channel — all live at once.

---

## Local SafeT vs cloud SafeT

The SafeT **bridge worker runs `ffmpeg` on the SafeT _server_**, not on this PC.
So each bridge's `sourceUrl` must be reachable **from the server**:

- **Self-hosting SafeT on this same PC** → leave
  `icecast.serverReachableBase: "http://127.0.0.1:8000"`. Done.
- **SafeT in the cloud (e.g. Railway)** → the server cannot reach this PC's
  `localhost`. Expose Icecast with a tunnel and use its public URL, e.g.:

  ```bash
  cloudflared tunnel --url http://127.0.0.1:8000
  # -> https://something.trycloudflare.com
  ```

  Set `"serverReachableBase": "https://something.trycloudflare.com"`, re-run
  `npm run generate && npm run import-bridges`. (A LAN IP works too if the server
  is on the same network.)

---

## Tuning

- **VOX too twitchy / too deaf** — adjust `bridgeDefaults.voxThreshold`
  (0–1, lower = more sensitive) and `voxHangMs` (tail before un-keying). Per-
  talkgroup overrides go on the individual `bridges[]` entry. SafeT re-reads
  bridges within ~15s.
- **`yieldToUnits`** — `false` (default) keeps scanner traffic on-air even when a
  real unit keys the same SafeT channel; set `true` to let live units pre-empt.
- **Volume** — tweak the `volume=` in `generated/stream-talkgroups.sh` if a feed
  is hot/quiet (re-generate to reset).
- **More talkgroups** — add to `bridges[]`, re-generate, re-import. Each new entry
  gets the next UDP port automatically.

## Troubleshooting

- **No mounts in Icecast** — streamers not running, or `sourcePassword` mismatch
  between `system.json` and what Icecast loaded. Re-`generate` after edits.
- **Mounts exist but never key** — trunk-recorder isn't decoding: check it locked
  the control channel (its log), verify `controlChannelsHz`, `gain`, `ppm`, and
  that `rtl_test` sees the dongle. In Docker, confirm `network_mode: host` so the
  UDP targets reach the host streamers.
- **SafeT bridge shows level 0 / never connects** — the server can't reach
  `sourceUrl`. Almost always the local-vs-cloud reachability issue above.
- **Control channel won't lock / all noise** — wrong `modulation`. Try the other
  (`qpsk` ↔ `fsk4`), confirm `controlChannelsHz`, `gain`, and `ppm`. Phase II voice
  is auto-detected once the control channel locks — there's no phase flag.

> The RF/decoder pipeline (trunk-recorder ↔ simplestream ↔ ffmpeg ↔ Icecast)
> depends on your exact dongle, antenna, and the OC CCCS site — treat the RF
> values as a starting point and validate against your RadioReference data. The
> SafeT side (channel + bridge creation) is exact and idempotent.

## Legal

Monitor only what you're licensed/permitted to in your jurisdiction, and don't
re-stream encrypted or restricted talkgroups. Scanner legality varies by state.
