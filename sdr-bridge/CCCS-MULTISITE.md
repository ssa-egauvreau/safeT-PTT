# OC CCCS is multi-site — why "North" and "Carbon Canyon" don't decode

> Short version: **OC CCCS is not one tower, it's ~11 sites**, and SDRTrunk
> follows **one site per channel configuration**. "OCSD Transit North", "Carbon
> Canyon", "TAN-NORTH/SOUTH" ride sites you're not locked to, so you never hear
> them — even though your dongles can physically tune the 853 MHz block their
> control channels live in. Covering a 853.xxx control channel ≠ following that
> site.

## The misconception

Orange County's **Countywide Coordinated Communications System (CCCS)** is a
**multi-site P25 trunked system** (RadioReference SID 7548, System ID `45C`,
WACN `BEE00`). It has roughly eleven sites/cells, each a different physical tower
with **its own distinct control + traffic channels**:

| Site | Name | Example control channels (verify on RadioReference) |
|------|------|------|
| 021 | Countywide (simulcast) | 856.7125, 857.4625, 860.2125, 860.4625 |
| 022 | South | 853.625, 853.675, 853.925 |
| 023 | **North** | 853.150, 853.175, 853.400, 853.650 |
| 024 | Northwest | 852.325, 852.850, 853.325, 853.700 |
| 025 | Southwest | 852.350, 853.200, 853.350, 853.825 |
| 029 | **Carbon Canyon** ASR | 852.2125, 853.3125 |
| … | Laguna / Silverado / Loma Ridge / etc. | (see RR) |

> ⚠️ **Always confirm the current frequencies on RadioReference** (db SID 7548) —
> sites get re-banded and channels change. The table is a starting point, not
> gospel.

"Several control channels share the 853.xxx block" just means several **different
sites** happen to live near each other in 853 MHz. It does **not** mean one
control channel carries every site's traffic. The North site's control channel
(853.150…) and the Countywide site's control channels (856–860) are different
radios on different towers carrying different calls.

## Why a talkgroup stays silent even when you "cover" its frequency

Two things have to both be true for you to hear a call:

1. **You're locked to the control channel of the site the call is on.** In a
   multi-site P25 system, a call is only transmitted on the site(s) where an
   affiliated radio is currently registered. A unit working the North area
   affiliates on the **North site**, so its calls go out on the North site only.
2. **SDRTrunk is actually following that site.** SDRTrunk locks to **one control
   channel per channel configuration** and does **not** scan or roam across sites
   (unlike OP25's multi-site follow). If your channel config points at the
   Countywide or South control channel, North/Carbon Canyon calls will **never**
   appear there — regardless of whether your dongle could tune their control
   channel.

So "my dongle covers 853.xxx" is necessary but not sufficient: you also need a
**SDRTrunk channel configured for that specific site's control channel**, locked
and decoding.

## How to actually monitor North / Carbon Canyon (with your 2 dongles)

SDRTrunk multi-site = **one P25 channel configuration per site**, each pointed at
that site's control channel, each given tuner spectrum that covers its control
**and** traffic channels.

1. **Add a channel config per site you want.** In the SDRTrunk Playlist Editor,
   create a P25 trunked channel for **Site 023 North** (control 853.150 / 853.175
   / 853.400 / 853.650 — add all of them as alternates so SDRTrunk rides through a
   control-channel failover) and another for **Site 029 Carbon Canyon ASR**
   (852.2125 / 853.3125).
2. **Assign each its own tuner / spectrum.** Each RTL-SDR sees ~2.4 MHz at once.
   The North site's channels sit ~853.1–853.7 (well under 2.4 MHz, fits one
   dongle); Carbon Canyon's two channels span ~852.2–853.3 (also fits). Put one
   site on each dongle. **You can realistically follow about 1–2 sites at a time
   with two dongles — you cannot watch all 11 at once.** Pick the sites whose
   talkgroups you actually care about (here: North + Carbon Canyon).
3. **Make sure the traffic channels fit too**, not just the control channel — a
   call grants onto a voice frequency, and if that frequency falls outside your
   tuned window the call won't decode even though the control channel is fine.
4. **Enable each channel** and confirm SDRTrunk shows a **decode lock** (sync, a
   live System/Site ID, messages/sec) on each site's control channel — not just
   energy on the waterfall.

> With these two site configs running, "OCSD Transit North" and the
> Carbon-Canyon-area talkgroups will decode **when units key up on those sites**.

## Other things to check

- **Phase 1 vs Phase 2.** RadioReference documents CCCS as P25 **Phase I**, but
  some cells may run **Phase II (TDMA)**. If a site is Phase 2, set its channel's
  decoder to **P25 Phase 2** and make sure the WACN (`BEE00`) / System ID (`45C`)
  are right, or the TDMA voice frames won't decode. (A Phase-1-only config misses
  Phase 2 voice entirely.) If calls play in SDRTrunk on one site, that site's
  phase is configured correctly.
- **Confirm it's the right system.** Check that the control channel you're decoding
  reports **WACN `BEE00` / SysID `45C`**. Orange County also runs the separate
  **CORNet** P25 system, and San Bernardino systems sit on nearby 800 MHz
  frequencies. A "TAN"-style or transit talkgroup on a *different* WACN/SysID is a
  different network and will never appear under your CCCS config. SDRTrunk shows
  the decoded WACN/SysID on the control channel — look at it.
- **Traffic Channel Pool size.** Bump each P25 config's pool (e.g. to 6–10) so a
  busy site doesn't run out of decode slots and silently drop calls.
- **RF range is real.** The North and Carbon Canyon ASR towers (Brea / Chino Hills
  border) are separate physical locations. Receiving a *closer* site's 853 control
  channel cleanly does not mean you can hear the North/Carbon Canyon tower. If
  SDRTrunk won't get a **decode lock** on that site's control channel (just noise
  / no sync), it's an antenna / range / line-of-sight problem, not config — try a
  higher or outdoor 800 MHz antenna aimed toward that tower.
- **Low-traffic groups are quiet by nature.** Transit and tactical TAN-1…5 groups
  can be idle for long stretches. Absence during a listening session isn't proof
  of a config error — if the site's control channel is locked and *other*
  talkgroups on that same site decode, the quiet group simply had no calls while
  you listened.

## Config vs. environment — an honest split

| You can fix in SDRTrunk | Depends on your location / timing |
|---|---|
| Add a channel config per site (North, Carbon Canyon) | Whether you can physically receive that tower |
| Point each at the right control channel(s) | Line-of-sight / antenna height toward Brea–Chino Hills |
| Set Phase 1 vs Phase 2 correctly | Whether a quiet talkgroup keys up while you listen |
| Raise the Traffic Channel Pool | — |
| Verify WACN `BEE00` / SysID `45C` | — |

## How this reaches SafeT

The SafeT bridge is downstream of all this: whatever SDRTrunk decodes and uploads
(per the `SafeT` RdioScanner stream — see [SDRTRUNK.md](./SDRTRUNK.md)) gets routed
to its SafeT channel by talkgroup ID, and every call also lands on **Scan All**.
So once North / Carbon Canyon decode in SDRTrunk, tag those talkgroups with the
`SafeT` broadcast channel (the app installs the alias list for you) and they'll
flow to SafeT like everything else. **The decode has to work in SDRTrunk first** —
SafeT can't surface a call SDRTrunk never heard.

---

Sources: RadioReference [SID 7548](https://www.radioreference.com/db/sid/7548) and
the [CCCS wiki](https://wiki.radioreference.com/index.php/Countywide_Coordinated_Communications_System_(CCCS)_(P25)) +
[FleetMap](https://wiki.radioreference.com/index.php/Countywide_Coordinated_Communications_System_(CCCS)_FleetMap_Info);
SDRTrunk [APCO-25 wiki](https://github.com/DSheirer/sdrtrunk/wiki/APCO25).
