# Product Backlog: SafeT Radio Platform

## Scope
This backlog translates the approved roadmap into implementation-ready artifacts:
1. GitHub issue drafts with acceptance criteria.
2. Database schema change plan.
3. API contract stubs for first three epics.

---

## 1) GitHub Issues Drafts

### EPIC-1: Emergency Workflow Hardening

#### ISSUE-1.1 — Add emergency lifecycle state machine
**Description**
Implement deterministic emergency states: `active -> acknowledged -> resolved`.

**Tasks**
- Add lifecycle columns and transitions in persistence layer.
- Ensure first-acknowledger wins.
- Reject invalid state regressions.

**Acceptance Criteria**
- New emergencies default to `active`.
- Only first ACK succeeds; later ACK attempts return conflict.
- `resolved` requires prior `acknowledged`.

---

#### ISSUE-1.2 — Add escalation policy and scheduler
**Description**
Support per-agency escalation if emergencies remain unacknowledged past threshold.

**Tasks**
- Add policy model (`escalate_after_seconds`, `notify_roles`).
- Implement periodic checker and one-shot escalation event.
- Log escalations to audit stream.

**Acceptance Criteria**
- Escalation fires once at or after threshold.
- Duplicate escalation events are prevented.
- Escalation includes agency and emergency identifiers.

---

#### ISSUE-1.3 — Incident report export (JSON/CSV)
**Description**
Provide post-incident export for emergency timelines.

**Tasks**
- Build aggregation query across emergency + alerts + transmission refs.
- Add export endpoint with auth/permission checks.
- Support JSON and CSV response formats.

**Acceptance Criteria**
- Export contains full event timeline ordered by timestamp.
- Includes actor and audit metadata where available.
- Returns 404 for unknown emergency IDs in caller scope.

---

### EPIC-2: Offline / Degraded Handset Mode

#### ISSUE-2.1 — Connectivity state machine
**Description**
Define client connectivity states for field usability.

**Tasks**
- Add state enum: `online | degraded | offline | recovering`.
- Emit transitions from network transport events.
- Add UI bindings for status banner and cues.

**Acceptance Criteria**
- State changes are observable within one second of connectivity changes.
- Transition history is available for diagnostics.

---

#### ISSUE-2.2 — Durable client action queue
**Description**
Queue retry-safe non-voice actions while offline.

**Tasks**
- Persist queue with replay metadata and backoff.
- Add idempotency token per queued action.
- Replay on reconnect with conflict-safe semantics.

**Acceptance Criteria**
- Queued actions survive app restart.
- Duplicate side effects are prevented server-side.
- Failed replays include machine-readable reason codes.

---

#### ISSUE-2.3 — Recovery diagnostics endpoint
**Description**
Allow operators/admins to inspect sync/replay failures.

**Tasks**
- Add endpoint for recent replay failures.
- Include agency, unit, action type, error code, last retry timestamp.
- Gate access to admin/dispatcher roles.

**Acceptance Criteria**
- Endpoint returns deterministic pagination.
- Sensitive payloads are redacted in errors.

---

### EPIC-3: Presence v2

#### ISSUE-3.1 — Presence model expansion
**Description**
Upgrade from TTL-only presence to operationally useful state.

**Tasks**
- Add `status`, `last_seen_at`, `current_channel`, `tx_capability`.
- Preserve agency/channel namespacing.
- Maintain compatibility with existing heartbeat input.

**Acceptance Criteria**
- Presence records expire by policy while retaining last-known metadata.
- No cross-agency presence leakage.

---

#### ISSUE-3.2 — Stale/ghost diagnostics
**Description**
Expose heartbeat quality metrics.

**Tasks**
- Track jitter, missed heartbeats, stale counters.
- Add service-level metrics export.

**Acceptance Criteria**
- Diagnostics expose top stale units per agency.
- Counters reset correctly on fresh heartbeat.

---

#### ISSUE-3.3 — Channel roster summary endpoint
**Description**
Provide fast read endpoint for per-channel active unit summaries.

**Tasks**
- Add aggregate endpoint for counts by status.
- Return compact DTO suitable for web/desktop console refresh.

**Acceptance Criteria**
- p95 latency under 200ms for baseline tenant dataset.
- Response includes timestamp and staleness indicator.

---

## 2) Database Schema Change Plan

### Migration A: Emergency lifecycle
- `emergencies` table additions:
  - `state text not null default 'active'`
  - `ack_by_user_id bigint null`
  - `ack_at timestamptz null`
  - `resolved_by_user_id bigint null`
  - `resolved_at timestamptz null`
- Check constraint:
  - state in (`active`, `acknowledged`, `resolved`)
- Transition rule enforcement in service layer.

### Migration B: Escalation policy
- New table `agency_emergency_policies`:
  - `agency_id bigint primary key references agencies(id)`
  - `escalate_after_seconds integer not null`
  - `notify_roles text[] not null`
  - `updated_at timestamptz not null default now()`

### Migration C: Escalation events
- New table `emergency_escalations`:
  - `id bigserial primary key`
  - `emergency_id bigint not null references emergencies(id)`
  - `agency_id bigint not null references agencies(id)`
  - `escalated_at timestamptz not null default now()`
  - unique (`emergency_id`)

### Migration D: Presence v2 storage (optional durable mode)
- New table `unit_presence`:
  - `agency_id bigint not null`
  - `unit_id text not null`
  - `channel_norm text not null`
  - `status text not null`
  - `tx_capability text not null`
  - `last_seen_at timestamptz not null`
  - `heartbeat_jitter_ms integer null`
  - `missed_heartbeat_count integer not null default 0`
  - primary key (`agency_id`, `unit_id`, `channel_norm`)
- Indexes:
  - (`agency_id`, `channel_norm`, `status`)
  - (`agency_id`, `last_seen_at desc`)

### Migration E: Offline replay diagnostics
- New table `client_replay_failures`:
  - `id bigserial primary key`
  - `agency_id bigint not null`
  - `unit_id text not null`
  - `action_type text not null`
  - `idempotency_key text not null`
  - `error_code text not null`
  - `last_retry_at timestamptz not null`
  - unique (`idempotency_key`)

---

## 3) API Contract Stubs (First 3 Epics)

Base path: `/v1`

### Emergency workflow

#### `POST /emergencies/:id/ack`
Ack an active emergency.

**Request body**
```json
{ "note": "optional string" }
```

**Success 200**
```json
{
  "emergencyId": 123,
  "state": "acknowledged",
  "ackByUserId": 45,
  "ackAt": "2026-05-18T10:00:00Z"
}
```

**Errors**
- `401 unauthorized`
- `403 forbidden`
- `404 not_found`
- `409 already_acknowledged`

#### `POST /emergencies/:id/resolve`
Resolve an acknowledged emergency.

**Success 200** returns resolved state payload.
**Errors** include `409 invalid_state_transition`.

#### `GET /emergencies/:id/export?format=json|csv`
Return post-incident timeline export.

---

### Offline/degraded support

#### `GET /radio/recovery/failures?cursor=...&limit=50`
Return replay failure diagnostics for agency operators.

**Success 200**
```json
{
  "items": [
    {
      "id": 9001,
      "unitId": "A12",
      "actionType": "presence_heartbeat",
      "errorCode": "timeout",
      "lastRetryAt": "2026-05-18T10:05:00Z"
    }
  ],
  "nextCursor": null
}
```

---

### Presence v2

#### `POST /radio/presence/heartbeat`
Upsert unit presence state.

**Request body**
```json
{
  "unitId": "A12",
  "channel": "Dispatch 1",
  "status": "online",
  "txCapability": "allowed",
  "clientTs": "2026-05-18T10:00:00Z"
}
```

**Success 200**
```json
{ "ok": true, "serverTs": "2026-05-18T10:00:01Z" }
```

#### `GET /presence/channels/:name/summary`
Get per-channel active counts by status.

**Success 200**
```json
{
  "channel": "dispatch 1",
  "asOf": "2026-05-18T10:00:01Z",
  "counts": {
    "online": 12,
    "in_call": 2,
    "rx_only": 1,
    "tx_denied": 0
  },
  "staleUnits": 1
}
```

---

## Suggested Labels
- `epic:emergency`
- `epic:offline`
- `epic:presence`
- `type:backend`
- `type:mobile`
- `priority:p0`
- `priority:p1`

## Suggested Milestones
1. `M1 Safety & Reliability`
2. `M2 Dispatch Productivity`
3. `M3 Governance & Scale`
