# SSA shift → radio/vehicle assignment integration

Lets the **SSA portal** (the separate `ssa-parking` repo, where officers start a
shift and pick their patrol car / radio) tell safeT-PTT which officer is on which
radio for the shift. safeT then shows the officer's **callsign** (e.g. `351`) —
not the raw radio or vehicle number — on the map, on other radios, in the
recording log, and to the **AI dispatcher**, and tags whether the radio is a
**car** (mobile) or a **handheld** (portable).

## Why this exists

Every identity in safeT rides on one free-text string, `unit_id`. A radio
reports its own `unit_id` when it joins voice. For a **car radio** that value is
usually the *vehicle* number, so when an officer keys up without saying their
callsign, the AI dispatcher (and the map, and other radios) fall back to that
vehicle number instead of the officer's callsign. A shift assignment supplies the
missing `radio → officer callsign` mapping, applied the moment the radio joins.

## The model

A **shift assignment** maps one radio to one officer for a shift:

| Field | Meaning |
|-------|---------|
| `radio_unit_id` | The unit id the radio reports when it joins voice — the assignment key. For a car radio this is typically the vehicle/mobile number the radio is provisioned with; for a handheld it's the handheld's radio id. **This is the value safeT already shows for that radio today.** |
| `officer_callsign` | What the officer should be called on air / on the map (e.g. `351`). |
| `officer_display_name` | Friendly name for the map / roster (e.g. `J. DOE`). Optional. |
| `vehicle_unit` | Patrol vehicle number for the shift. Informational. Optional. |
| `radio_kind` | `car` or `handheld`. Distinguishes a mobile radio from a portable. Optional but recommended. |
| `external_ref` | The portal's own shift/roster id, for traceability. Optional. |

Rules:

- **One active assignment per callsign, and per radio.** An officer is on one
  radio at a time. Re-posting the same `radio_unit_id`, or moving a `callsign`
  to a new radio, supersedes the previous assignment. (The callsign becomes the
  unit's identity across every correlated surface — air, roster, map,
  emergencies — so it must map to exactly one radio.) If an officer switches
  from their handheld to a car radio mid-shift, POST the new radio; the old one
  is ended automatically. The vehicle they're driving is recorded as
  `vehicle_unit` regardless of which radio they're on.
- Assignments apply to an **already-connected** radio immediately (its next
  keyup and the roster reflect the new callsign), and to the **next map poll**;
  a radio that connects later picks it up at join.

## Auth

The portal authenticates with a **per-agency shift key** — a single opaque secret
that both identifies the agency and authorizes the call. It grants **only** the
`/v1/ssa/shift*` endpoints; never PTT, admin, or any other write.

Issue it once from the agency admin console (or via the API below), then store it
in the portal's server-side config.

```
# As an agency admin (admin JWT):
POST   /v1/admin/shift-key      -> { "shift_key": "<new key>" }   # issue / rotate
GET    /v1/admin/shift-key      -> { "shift_key": "<key|null>" }  # view current
DELETE /v1/admin/shift-key      -> { "ok": true }                 # revoke
```

The portal then sends the key on every request, either header or query:

```
X-SafeT-Shift-Key: <shift_key>
# or  ?shift_key=<shift_key>
```

(An agency **admin/dispatcher** JWT is also accepted on these endpoints, e.g. for
testing from the console. Radio-handset tokens and platform owners are rejected.)

## Endpoints

Base URL: `https://safet-ptt.com/v1`

### Start / replace a shift assignment

```
POST /v1/ssa/shift
X-SafeT-Shift-Key: <shift_key>
Content-Type: application/json

{
  "radio_unit_id": "3351",        // required — the radio's own unit id
  "officer_callsign": "351",      // required — what shows + what the AI says
  "officer_display_name": "J. DOE",
  "vehicle_unit": "351",
  "radio_kind": "car",            // "car" | "handheld"
  "external_ref": "shift_9f2c"
}
```

Response `200`:

```json
{ "assignment": {
  "id": 12, "agency_id": 3,
  "radio_unit_id": "3351", "officer_callsign": "351",
  "officer_display_name": "J. DOE", "vehicle_unit": "351",
  "radio_kind": "car", "external_ref": "shift_9f2c",
  "active": true, "started_at": "…", "ended_at": null, "updated_at": "…"
} }
```

Errors: `400 missing_fields` (need `radio_unit_id` + `officer_callsign`),
`400 invalid_radio_kind` (must be `car`/`handheld` when present),
`401 unauthorized` (bad/missing key), `503 database_unavailable`.

### End a shift

```
POST /v1/ssa/shift/end
X-SafeT-Shift-Key: <shift_key>
Content-Type: application/json

{ "radio_unit_id": "3351" }          // and/or "officer_callsign": "351"
```

Deactivates matching active assignment(s). Passing only `officer_callsign` ends
every radio that officer holds (handheld + car). Response: `{ "ok": true, "ended": 1 }`.

### List / look up active assignments

```
GET /v1/ssa/shift                       -> { "assignments": [ … ] }
GET /v1/ssa/shift?radio_unit_id=3351    -> { "assignment": { … } | null }
```

The portal reconciles its shift board against this (e.g. on reconnect).

## What changes inside safeT

- **Voice join** (`voiceRelay.ts`): the active assignment for the joining radio's
  `unit_id` overrides `unitId`/`displayName` → propagates to `/v1/air`, the
  `air_claimed` push to other radios, the recorder, and thus
  `transmissions.unit_id` which the AI dispatcher reads.
- **Map** (`GET /v1/locations`): overlays the active assignment so a position row
  shows the officer callsign + name and a `radio_kind` badge, while keeping the
  raw id in `radio_unit_id`.
- **AI dispatcher**: no dispatcher change needed — because the transmission now
  carries the officer callsign, the "vehicle number instead of callsign" fallback
  no longer fires.

## Notes

- Send the radio's `unit_id` **exactly as safeT knows it** (whatever shows for
  that radio today). Matching is case-insensitive.
- With no database (local dev) the endpoints return `503`; the join override and
  map overlay simply no-op, so handsets still work.
