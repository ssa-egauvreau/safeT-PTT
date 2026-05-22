# 10-8 Systems API specs

OpenAPI specs for the 10-8 Systems integrations used by AI dispatch. Saved here
because the build/runtime environment can't reach SwaggerHub.

| File | What it is | How safeT uses it |
|------|------------|-------------------|
| `incident-export-webhook-1.0.0.json` | Incident Export **webhook** (10-8 → safeT) | `server/src/ten8/webhook.ts` ingests `POST /v1/webhooks/10-8`. Payload is `{action, incident}`; `incident.units[].unit` and `incident.comments[].comment` drive comment matching and call-detail read-back. |
| `cad-api-1.0.8.json` | **CAD API** reads + comments (safeT → 10-8) | `ten8ListIncidents`, `ten8AddComment` (`POST /v1/incidents/{lookup}/comments`, body `{officer, comment, type}`). Host: AWS gov gateway. Rejects special characters — comments are sanitized to `[A-Za-z0-9 ]`. |
| `new-incident-api-1.0.0.json` | **New Incident API** create calls (safeT → 10-8) | `ten8CreateIncident` (`POST interface.10-8systems.com/incidents`, Basic auth). Required: `type` + `summary`. Used for self-dispatch (`intent=dispatch`). |

Source: SwaggerHub `10-8systems-bryan`. Update these files if 10-8 publishes a new version.
