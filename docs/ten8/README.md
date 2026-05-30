# 10-8 Systems API specs

OpenAPI specs for the 10-8 Systems integrations used by AI dispatch. Saved here
because the build/runtime environment can't reach SwaggerHub.

| File | What it is | How safeT uses it |
|------|------------|-------------------|
| `incident-export-webhook-1.0.0.json` | Incident Export **webhook** (10-8 → safeT) | `server/src/ten8/webhook.ts` ingests `POST /v1/webhooks/10-8`. Payload is `{action, incident}`; `incident.units[].unit` and `incident.comments[].comment` drive comment matching and call-detail read-back. |
| `cad-api-1.1.0.json` | **CAD API** reads + comments + vehicles (safeT → 10-8) | `ten8ListIncidents`, `ten8AddComment` (`POST /v1/incidents/{lookup}/comments`, body `{officer, comment, type}`), `ten8AddVehicle`. Host: `connect.10-8systems.com` (see host note). Rejects special characters — comments are sanitized to `[A-Za-z0-9 ]`. v1.1.0 additionally exposes person/vehicle **search** (`GET /v1/persons`, `GET /v1/vehicles` → full record + `calls[]`) and **UUID** incident lookup — surfaced today via the Admin → AI Test "10-8 CAD API Tester". |
| `new-incident-api-1.0.0.json` | **New Incident API** create calls (safeT → 10-8) | `ten8CreateIncident` (`POST interface.10-8systems.com/incidents`, Basic auth). Required: `type` + `summary`. Used for self-dispatch (`intent=dispatch`). |

> **v1.1.0 host note:** 10-8's v1.1.0 spec lists only `https://connect.10-8systems.com` as the
> server. The old AWS GovCloud gateway (`ps569km5w9…execute-api.us-gov-west-1.amazonaws.com`) was
> dropped from the published server list and now returns **HTTP 502** even on the unauthenticated
> `/v1/health`, so safeT's default CAD base URL (`DEFAULT_BASE`) was **repointed to
> `connect.10-8systems.com`**. Per-agency overrides via `ten8_api_base_url` still win for anyone on a
> different host. Incident creation is unaffected — it still uses `interface.10-8systems.com` (New
> Incident API, Basic auth), overridable via `ten8_new_incident_api_base_url`. `cad-api-1.0.8.json` is
> retained only for the historical GovCloud host reference. v1.1.0 also adds a unified
> `POST /v1/incidents` create endpoint (X-API-Key), but safeT continues to create calls through the
> separate New Incident API.

Source: SwaggerHub `10-8systems-bryan`. Update these files if 10-8 publishes a new version.
