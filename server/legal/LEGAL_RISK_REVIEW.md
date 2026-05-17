# safeT PTT — Legal & Compliance Risk Review

> **DRAFT — NOT LEGAL ADVICE.** This document was prepared from a review of the
> source code in this repository. It is an engineering-level risk assessment to
> help scope work for qualified counsel. It is **not** a legal opinion and must
> be reviewed by a licensed attorney (and, for the patent items, by patent/IP
> counsel) before the platform is distributed or sold.

- **Repository:** `radio-platform` (safeT PTT)
- **Review date:** 2026-05-17
- **Scope:** Android handset app (`android-app/`), Node/Express backend
  (`server/`), web dispatch console (`server/web-console/`), desktop shell
  (`desktop-console/`).
- **Target market (per README):** private enterprise push-to-talk for public
  safety; US enterprise customers.

---

## 1. Summary of findings

| # | Finding | Severity | Area |
|---|---------|----------|------|
| 1 | GPL-licensed vocoder code is compiled into the apps, contaminating the proprietary codebase | **Critical** | Open-source licensing |
| 2 | The bundled vocoder mixes GPL-2.0-only and GPL-3.0-or-later code — mutually incompatible | **Critical** | Open-source licensing |
| 3 | IMBE / AMBE codecs are patent-encumbered (DVSI); no freedom-to-operate clearance | **High** | Patents |
| 4 | "Radio" API endpoints are unauthenticated by default; recording audio endpoint has no channel-scope check (IDOR) | **High** | Data security → breach liability |
| 5 | All voice traffic is recorded and transcribed with no consent flow — wiretap/eavesdropping exposure | **High** | Recording / privacy law |
| 6 | Continuous GPS tracking of personnel with no notice or consent mechanism | **Medium-High** | Employee-monitoring law |
| 7 | No data-retention limits and no data-subject access/deletion path | **Medium** | CCPA/CPRA, retention |
| 8 | UI deliberately mimics the Motorola APX radio; trademark/trade-dress exposure | **Medium** | Trademark / trade dress |
| 9 | Insecure defaults (seeded admin password, unverified DB TLS, `allowBackup`) undermine security representations | **Medium** | Security posture |
| 10 | Marketed for "public safety" with no life-safety reliability disclaimer in product | **Medium** | Product liability |
| 11 | No third-party / open-source attribution file (`NOTICES`) | **Low-Medium** | Open-source compliance |
| 12 | Web console uses the public OpenStreetMap tile servers, against their usage policy | **Low-Medium** | Third-party ToS |
| 13 | Machine-generated transcripts may be relied on as accurate records | **Low** | Evidentiary / liability |
| 14 | Inconsistent / missing project licensing (`desktop-console` is `UNLICENSED`, no root `LICENSE`) | **Low** | Licensing hygiene |

---

## 2. Detailed findings

### Finding 1 — GPL vocoder code contaminates the proprietary codebase (Critical)

**What.** The IMBE/AMBE voice codec under
`android-app/app/src/main/cpp/dvmvocoder/` is licensed under the GNU GPL. Headers
carry `SPDX-License-Identifier: GPL-2.0-only` (e.g. `vocoder/MBEDecoder.h`,
`vocoder/mbe.h`, `vocoder/AMBEFEC.h`) and the IMBE implementation
(`vocoder/imbe/imbe_vocoder.h`) is GPL-3.0-or-later.

This code is not isolated. It is compiled into **three** distributed artifacts:

- the Android APK, via the JNI bridge `android-app/app/src/main/cpp/p25_jni.cpp`;
- a WebAssembly module shipped to browsers — `server/web-console/cpp/p25_wasm.cpp`,
  built by `server/web-console/cpp/build-vocoder.sh` into
  `server/web-console/src/vendor/imbeModule.js`;
- a server-side WASM module `server/vocoder/imbeModule.mjs`, used by
  `server/src/imbeServerCodec.ts`.

**Risk.** The GPL is a "copyleft" license. When GPL code is combined into a
single program (static linking, JNI native libraries, WASM bundled with app
code), the **entire combined work** is a derivative work that may only be
distributed under the GPL, with an offer of complete corresponding source code
to every recipient. Consequences:

- The Android APK and the web/desktop console cannot lawfully be distributed as
  proprietary, "private" software while they contain this code. The README's
  plan of "private APKs" does not avoid the obligation — handing a binary to an
  enterprise customer is "conveying" under the GPL, which triggers the source
  offer, and that customer then has the right to redistribute.
- The `desktop-console` `package.json` declares `"license": "UNLICENSED"` — this
  is **inconsistent** with shipping GPL code inside it.
- Operating the **server** purely as a hosted service (SaaS) does *not* by
  itself trigger GPL distribution (GPLv2/3 are not network-copyleft like AGPL).
  But the moment any binary leaves your servers — the APK, the browser WASM, the
  Electron desktop build — distribution obligations attach.

**Recommendation.**
1. Decide deliberately: either (a) license the safeT client apps under the GPL
   and publish complete corresponding source, or (b) **replace the vocoder**
   with a non-copyleft codec (e.g. Opus, BSD-licensed; or a commercially
   licensed IMBE/AMBE library — see Finding 3) and remove the `dvmvocoder` tree.
2. If keeping GPL code short-term, isolate it behind a process/IPC boundary and
   get a written legal opinion on whether that is sufficient separation — do not
   rely on the IPC-boundary theory without counsel sign-off.
3. Until resolved, treat the client apps as **not cleared for distribution**.

---

### Finding 2 — GPL-2.0-only and GPL-3.0 code are combined and are incompatible (Critical)

**What.** Within the same compiled vocoder library:

- the MBE/DVM files declare `GPL-2.0-only` (no "or later" — see the SPDX banners
  in `vocoder/mbe.h`, `vocoder/MBEDecoder.h`, `vocoder/AMBEFEC.h`,
  `vocoder/imbe7200x4400.c`);
- `vocoder/imbe/imbe_vocoder.h` is licensed "GNU General Public License … either
  version 3, or (at your option) any later version" — i.e. GPL-3.0-or-later.

GPL-2.0-**only** and GPL-3.0 are **mutually incompatible**: GPL-2.0-only code
cannot be relicensed to v3, and GPL-3.0 code cannot be used under v2. There is
no single license under which the combined binary can be distributed.

Separately, `vocoder/mbe.h` and `vocoder/imbe7200x4400.c` carry a
`GPL-2.0-only` SPDX tag **but** the body text is the permissive **ISC** license
("Permission to use, copy, modify, and/or distribute this software for any
purpose…"). The file's stated license is internally contradictory.

**Risk.** As bundled, the vocoder tree arguably **cannot be lawfully distributed
at all**, because no license satisfies every file simultaneously. The
ISC/GPL labelling conflict creates additional ambiguity about what terms
actually govern those files.

**Recommendation.** Have counsel resolve the per-file license of every file
under `dvmvocoder/` against its true upstream
(`https://github.com/WhackerLink/dvmvocoder`, mbelib, and Pavel Yazev's IMBE
implementation). Most likely outcome: this reinforces Finding 1's recommendation
to replace the codec. Do not "fix" the conflict by editing the SPDX banners —
the `README.txt` correctly warns against stripping copyright banners, and doing
so would itself be a license violation.

---

### Finding 3 — IMBE / AMBE codec patents; no freedom-to-operate clearance (High)

**What.** The bundled codecs implement **IMBE** (P25, `DECODE_88BIT_IMBE`) and
**AMBE** (DMR, `DECODE_DMR_AMBE`) — see `vocoder/MBEDecoder.h`. IMBE and the
AMBE/AMBE+2 family are proprietary voice codecs developed by Digital Voice
Systems, Inc. (DVSI) and have historically been covered by US patents. An
open-source *software* implementation does **not** carry a patent license.

**Risk.** DVSI has a documented history of asserting its codec patents,
including against software implementations. Many of the original 1990s-era IMBE
patents are likely expired, but newer AMBE/AMBE+2 patents may still be in force
depending on filing dates and jurisdiction. A **commercial public-safety
product** that ships both an IMBE and an AMBE decoder is squarely the kind of
use a patent holder cares about. Note also that GPLv2 §7 and GPLv3 §11 do **not**
grant you any third party's patent rights; GPLv2 §7 in fact bars distribution at
all if a patent makes royalty-free distribution impossible.

**Recommendation.**
1. Engage **patent counsel** for a freedom-to-operate / clearance review of the
   IMBE and AMBE decoders before any commercial release.
2. Strongly prefer designing the product around a **royalty-free, unencumbered
   codec** (e.g. Opus). If P25/DMR codec interoperability is genuinely required,
   budget for a **commercial license from DVSI** (typically a hardware/chip or
   licensed-software arrangement).
3. Until cleared, do not represent the product as P25/DMR-interoperable in
   marketing.

---

### Finding 4 — Unauthenticated radio endpoints and an audio-access IDOR (High)

**What.**
- The handset endpoints `/v1/radio/location`, `/v1/radio/inbox`,
  `/v1/radio/emergency` are gated only by an **optional** shared key. In
  `server/src/index.ts`, the `RADIO_API_KEY` check is skipped entirely when the
  env var is unset (`if (!radioApiKey || …) next()`). With no key configured,
  anyone on the internet can submit a forged GPS position for any unit, read
  another unit's alert inbox, or raise an emergency alert.
- `/v1/transmissions/:id/audio` (`server/src/apiRoutes.ts`) requires a logged-in
  user but, unlike the metadata list endpoint, does **not** restrict the audio
  download to channels the caller may access. Any authenticated user — including
  a low-privilege `radio` account — can fetch **any** recording by iterating the
  sequential integer `id` (an insecure direct object reference).

**Risk.** The platform stores voice recordings and the live locations of
identifiable people (often security/public-safety personnel). Unauthorized
access to that data is a data breach. US state breach-notification statutes can
treat voice recordings and precise geolocation tied to an individual as
"personal information," triggering notice obligations, regulatory exposure, and
contractual liability to customers. It also flatly contradicts any "we protect
your data" language in the Privacy Policy and Terms.

**Recommendation.**
1. Make `RADIO_API_KEY` (or, better, per-device credentials) **mandatory** —
   fail closed if it is unset.
2. Scope `/v1/transmissions/:id/audio` to the caller's accessible channels, the
   same way `listTransmissions` already scopes the metadata list.
3. Add rate limiting and authentication to all `/v1/radio/*` endpoints.
4. Treat this as a prerequisite before any production deployment or before the
   security representations in the legal documents can be made truthfully.

---

### Finding 5 — Universal recording and transcription with no consent flow (High)

**What.** `server/src/recorder.ts` records **every** talk-spurt on every channel
into the `transmissions` table (`audio BYTEA`), and `server/src/transcribe.ts`
auto-transcribes each recording with a self-hosted Whisper model
(`Xenova/whisper-tiny.en`). The handset app shows **no** recording notice, no
consent screen, and no recording indicator.

**Risk.** Recording of voice communications is regulated in the US by the
federal Wiretap Act (18 U.S.C. § 2511, one-party consent) and by state law.
Roughly a dozen states require **all-party** consent (e.g. California Penal Code
§ 632, plus Florida, Illinois, Pennsylvania, Washington and others). An employer
generally may record its own business communications system, but typically only
where participants are on notice and have consented, and where the recording is
limited to business use. A "public safety" deployment raises the stakes:
recordings can become evidence and may be subject to litigation discovery, and —
if a customer is a government body — to public-records requests.

**Recommendation.**
1. Add an in-app recording notice and an explicit consent step at user
   provisioning / first login (handled in the EULA and Privacy Policy drafts).
2. Contractually require the **Customer** (the employer) to notify and obtain
   consent from its personnel, and to honor the consent laws of the
   jurisdictions where it operates — see the Terms of Service draft.
3. Publish a defined retention schedule for recordings and transcripts (see
   Finding 7).
4. Consider a per-channel "recording on/off" control with a visible indicator.

---

### Finding 6 — Continuous personnel location tracking without notice (Medium-High)

**What.** `android-app/.../device/LocationReporter.kt` reports fine GPS position
(latitude, longitude, accuracy, heading, speed) every ~12–15 seconds while
running; the server stores it in `radio_positions` and shows it on the dispatch
map. The app requests `ACCESS_FINE_LOCATION` and runs a foreground service.

**Risk.** This is electronic monitoring of workers. Several states require
written notice of electronic/location monitoring (e.g. New York's electronic
monitoring notice law; California, Connecticut and Delaware notice
requirements). Off-duty or out-of-scope tracking is a particular liability.
Precise geolocation is also "sensitive personal information" under
California's CPRA.

**Mitigating factor.** `radio_positions` is keyed by `unit_id` with an `UPSERT`,
so it stores only the *latest* position per unit rather than a full location
history — that limits exposure. But there is no documented limit on how long the
last-known position is kept, and no on/off control tied to shift status.

**Recommendation.**
1. Require Customers (employers) to give personnel written notice of location
   tracking — covered in the Terms of Service draft.
2. State clearly in the Privacy Policy and EULA that location is collected, when,
   and for what purpose.
3. Add an operational control so tracking runs only while a user is on shift /
   signed in, and document that location is on-duty only.

---

### Finding 7 — No retention limits and no data-subject request path (Medium)

**What.** `server/src/db.ts` creates the schema but there is no purge/retention
logic anywhere for `transmissions` (audio + transcripts), `audit_log` (which
stores actor IP addresses), or `alerts`. Data accumulates indefinitely. There is
no API to export or delete a person's data.

**Risk.** "Keep everything forever" conflicts with data-minimization
expectations and increases breach exposure. Under the CCPA/CPRA, the personnel
of a California business are "consumers" with rights to know, delete, and
correct their personal information; recordings, transcripts, location and audit
data are all personal information. Customers will also expect contractual
retention controls and the ability to route deletion/access requests to you.

**Recommendation.**
1. Implement a configurable retention period for recordings, transcripts, audit
   logs and alerts, with automatic purge.
2. Provide an administrative way to export and delete an individual's data so
   Customers can satisfy data-subject requests.
3. Reflect the retention schedule in the Privacy Policy (placeholders are marked
   in the draft).

---

### Finding 8 — UI deliberately mimics the Motorola APX radio (Medium)

**What.** The README instructs building an "APX-style radio shell" that
"mimic[s] the feel of a Motorola APX radio," while telling contributors not to
"copy Motorola branding or assets exactly." The Android `applicationId` is
`com.securityradio.ptt` and the product is variously called "safeT,"
"Security Radio," and "safeT PTT."

**Risk.** Imitating the general *feel* of a hardware product is usually
permissible. The exposure is narrower: (a) **trade dress** infringement if the
on-screen layout is a close, recognizable visual copy of a distinctive,
non-functional element of the APX design; (b) any use of Motorola's word marks
(including "APX") or logos/icons in code, assets, store listings or marketing.

**Recommendation.**
1. Keep functional layout (status strip, soft keys, PTT button) but ensure the
   visual styling is independently designed — no pixel-level copies of APX
   chrome.
2. Remove "APX" and any Motorola marks from all code, comments, assets, and
   marketing; the word "APX" should not ship in the product.
3. Settle on one product name and a consistent `applicationId` / namespace, and
   run a trademark clearance search on the chosen name before launch.

---

### Finding 9 — Insecure defaults undermine security representations (Medium)

**What.**
- `seedInitialAdmin()` in `server/src/store.ts` creates an `admin` account with
  a hardcoded fallback password `radio-admin` when `ADMIN_INITIAL_PASSWORD` is
  unset.
- `server/src/db.ts` connects to PostgreSQL with
  `ssl: { rejectUnauthorized: false }` — TLS without certificate validation,
  which does not protect against an active man-in-the-middle on the DB link.
- `JWT_SECRET` falls back to a random per-process secret if unset
  (`server/src/auth.ts`) — operationally fragile.
- The Android manifest sets `android:allowBackup="true"`, allowing app data to
  be extracted via `adb backup`.
- The app uses an Accessibility Service, a boot receiver, and
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` / `FOREGROUND_SERVICE_SPECIAL_USE` —
  these are sensitive permissions that draw Google Play policy review.

**Risk.** These are engineering issues, but they are *legally* relevant: a
Privacy Policy or Terms that promises "reasonable security measures" must be
truthful. Shipping with a known default password or unverified TLS could be
characterized as a deceptive practice and weakens breach defensibility.

**Recommendation.** Before relying on the security language in the legal
documents: require a strong admin password at first run, validate DB TLS
certificates, require `JWT_SECRET`, set `allowBackup="false"`, and document the
justification for the sensitive Android permissions (especially if distributing
via Google Play).

---

### Finding 10 — "Public safety" marketing with no life-safety disclaimer (Medium)

**What.** The README markets safeT PTT as a platform "for public safety,"
including an emergency button and emergency alerts. There is no in-product
disclaimer about reliability or emergency reliance.

**Risk.** If a customer relies on the app for life-safety dispatch and a
component fails (voice relay, emergency alert, network), the product-liability
and negligence exposure is significant. The app is an over-IP service and is not
public-safety-grade land-mobile radio; it depends on consumer networks and
device power management.

**Recommendation.** The EULA and Terms of Service drafts include prominent
"not a substitute for 911 or public-safety-grade LMR; no guarantee of
availability" disclaimers. Surface an equivalent notice **in the product** (first
run and/or near the emergency button), and avoid marketing language implying
guaranteed availability or P25-grade reliability.

---

### Finding 11 — No third-party / open-source attribution file (Low-Medium)

**What.** The project bundles many third-party components with attribution
requirements — Leaflet (BSD-2), lamejs (LGPL-3), JSZip (MIT), React/ReactDOM,
Express, `ws`, `pg`, bcryptjs, jsonwebtoken (MIT), `@huggingface/transformers`
(Apache-2.0), the Whisper `whisper-tiny.en` model (MIT, OpenAI), Roboto
Condensed fonts, Electron (MIT), and the GPL vocoder — but there is no `NOTICES`
/ `THIRD_PARTY_NOTICES` file.

**Recommendation.** Generate and maintain a `THIRD_PARTY_NOTICES` file listing
each component, its license, and required attributions. This is also where the
GPL written offer of source (Findings 1–2) belongs.

---

### Finding 12 — Web console uses the public OpenStreetMap tile servers (Low-Medium)

**What.** `server/web-console/src/pages/MapPanel.tsx` loads map tiles from
`https://{s}.tile.openstreetmap.org/...`.

**Risk.** The OpenStreetMap Foundation's public tile servers are provided under
a Tile Usage Policy that prohibits heavy or commercial use. A commercial
public-safety product relying on them risks being blocked and is out of
compliance with that policy. (Attribution itself is correctly set in the code.)

**Recommendation.** Use a commercial tile provider or self-host tiles for any
production/commercial deployment; keep the OpenStreetMap/ODbL attribution.

---

### Finding 13 — Machine transcripts may be treated as accurate records (Low)

**What.** Whisper transcripts are stored alongside recordings and surface in the
transmission log and search.

**Risk.** Automatic speech recognition is imperfect, especially with radio
audio, codecs, background noise and cross-talk. If transcripts are relied on as
authoritative in incident reports or as evidence, inaccuracies create liability.

**Recommendation.** Label transcripts in the UI as machine-generated and
best-effort, with the audio recording as the source of record; the Privacy
Policy and Terms drafts include this disclaimer.

---

### Finding 14 — Inconsistent / missing project licensing (Low)

**What.** There is no root `LICENSE` file; `desktop-console/package.json`
declares `"license": "UNLICENSED"`; `server` and `web-console` `package.json`
files are marked `"private": true` with no license.

**Recommendation.** Adopt a deliberate license posture for the safeT-authored
code once Findings 1–3 are resolved (the GPL vocoder constrains what is
possible), and make the declarations consistent across all packages.

---

## 3. Recommended next steps

1. **Block distribution** of the Android, web and desktop clients until
   Findings 1–3 (vocoder licensing and patents) are resolved with counsel.
2. Engage **IP/patent counsel** for the IMBE/AMBE freedom-to-operate review and
   **technology-transactions counsel** for the open-source licensing analysis.
3. Fix Finding 4 (authentication / IDOR) before any production deployment.
4. Implement consent, notice, retention and data-subject-request capabilities
   (Findings 5–7) so the Privacy Policy and Terms can be made truthful.
5. Have counsel review and localize the three companion drafts in this folder:
   - `PRIVACY_POLICY.md`
   - `TERMS_OF_SERVICE.md`
   - `EULA.md`
6. Add a `THIRD_PARTY_NOTICES` file and resolve project licensing (Findings
   11, 14).

All bracketed `[PLACEHOLDERS]` in the companion documents must be completed, and
every document must be reviewed and approved by a licensed attorney before use.
