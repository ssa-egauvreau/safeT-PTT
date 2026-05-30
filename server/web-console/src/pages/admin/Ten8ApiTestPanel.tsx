import { useMemo, useState } from "react";
import { api, describeError, type Ten8ApiTestResult } from "../../api";

/** Every CAD-API action the tester can exercise, with a friendly label. */
const ACTIONS: { value: string; label: string; write: boolean }[] = [
  { value: "health", label: "Health check (GET /v1/health)", write: false },
  { value: "list_incidents", label: "List incidents (GET /v1/incidents)", write: false },
  { value: "get_incident", label: "Get incident (GET /v1/incidents/{lookup})", write: false },
  { value: "search_persons", label: "Search persons (GET /v1/persons)", write: false },
  { value: "search_vehicles", label: "Search vehicles (GET /v1/vehicles)", write: false },
  { value: "add_vehicle", label: "Add vehicle (POST .../vehicles)", write: true },
  { value: "remove_vehicle", label: "Remove vehicle (DELETE .../vehicles)", write: true },
  { value: "add_person", label: "Add person (POST .../persons)", write: true },
  { value: "remove_person", label: "Remove person (DELETE .../persons)", write: true },
  { value: "add_tag", label: "Add tag (POST .../tags)", write: true },
  { value: "remove_tag", label: "Remove tag (DELETE .../tags)", write: true },
  { value: "add_comment", label: "Add comment (POST .../comments)", write: true },
  { value: "update_comment", label: "Update comment (PUT .../comments/{id})", write: true },
  { value: "create_incident", label: "Create incident (New Incident API)", write: true },
];

/** Which input fields each action needs. Kept declarative so the form stays compact. */
type FieldKey =
  | "lookup"
  | "from"
  | "to"
  | "field"
  | "q"
  | "firstName"
  | "lastName"
  | "dob"
  | "phone"
  | "stateIDNumber"
  | "sex"
  | "race"
  | "license"
  | "vin"
  | "state"
  | "make"
  | "model"
  | "color"
  | "type"
  | "year"
  | "limit"
  | "vehicleId"
  | "personId"
  | "tag"
  | "tagId"
  | "relation"
  | "notes"
  | "comment"
  | "commentId"
  | "createType"
  | "priority"
  | "location"
  | "units";

const FIELDS_BY_ACTION: Record<string, FieldKey[]> = {
  health: [],
  list_incidents: ["from", "to", "field"],
  get_incident: ["lookup"],
  search_persons: [
    "q",
    "firstName",
    "lastName",
    "dob",
    "phone",
    "stateIDNumber",
    "sex",
    "race",
    "limit",
  ],
  search_vehicles: [
    "q",
    "license",
    "vin",
    "state",
    "make",
    "model",
    "color",
    "type",
    "year",
    "limit",
  ],
  add_vehicle: [
    "lookup",
    "license",
    "vin",
    "state",
    "make",
    "model",
    "color",
    "type",
    "year",
    "vehicleId",
    "notes",
  ],
  remove_vehicle: ["lookup", "vehicleId"],
  add_person: [
    "lookup",
    "firstName",
    "lastName",
    "dob",
    "phone",
    "sex",
    "race",
    "personId",
    "relation",
    "notes",
  ],
  remove_person: ["lookup", "personId"],
  add_tag: ["lookup", "tag", "tagId"],
  remove_tag: ["lookup", "tagId"],
  add_comment: ["lookup", "comment"],
  update_comment: ["lookup", "commentId", "comment"],
  create_incident: ["createType", "priority", "location", "units"],
};

const FIELD_LABELS: Record<FieldKey, string> = {
  lookup: "Lookup (id / number / UUID)",
  from: "From (unix seconds)",
  to: "To (unix seconds)",
  field: "Field (timestamp / timestamp_closed)",
  q: "q (fuzzy match)",
  firstName: "First name",
  lastName: "Last name",
  dob: "DOB",
  phone: "Phone",
  stateIDNumber: "State ID number",
  sex: "Sex",
  race: "Race",
  license: "License",
  vin: "VIN",
  state: "State",
  make: "Make",
  model: "Model",
  color: "Color",
  type: "Type",
  year: "Year",
  limit: "Limit (max 200)",
  vehicleId: "Vehicle ID",
  personId: "Person ID",
  tag: "Tag (name)",
  tagId: "Tag ID",
  relation: "Relation",
  notes: "Notes",
  comment: "Comment",
  commentId: "Comment ID",
  createType: "Type (call type)",
  priority: "Priority",
  location: "Location",
  units: "Units (comma-separated)",
};

/** Free-text fields that should render as a textarea rather than a single-line input. */
const TEXTAREA_FIELDS = new Set<FieldKey>(["comment", "notes"]);
/** Fields that carry numeric values and should be parsed before being sent. */
const NUMERIC_FIELDS = new Set<FieldKey>([
  "from",
  "to",
  "year",
  "limit",
  "vehicleId",
  "personId",
  "tagId",
  "commentId",
]);

/** Keys that belong inside the nested `vehicle` object for add_vehicle. */
const VEHICLE_OBJECT_FIELDS = new Set<FieldKey>([
  "license",
  "vin",
  "state",
  "make",
  "model",
  "color",
  "type",
  "year",
]);
/** Keys that belong inside the nested `person` object for add_person. */
const PERSON_OBJECT_FIELDS = new Set<FieldKey>([
  "firstName",
  "lastName",
  "dob",
  "phone",
  "sex",
  "race",
]);

export function Ten8ApiTestPanel() {
  const [action, setAction] = useState<string>("health");
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Ten8ApiTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = FIELDS_BY_ACTION[action] ?? [];
  const isWrite = useMemo(
    () => ACTIONS.find((a) => a.value === action)?.write === true,
    [action],
  );

  function setField(key: FieldKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  /** Read a trimmed string for a field. */
  function strOf(key: FieldKey): string {
    return (values[key] ?? "").trim();
  }

  /** Assemble the `params` object the server route expects for the current action. */
  function buildParams(): Record<string, unknown> {
    const params: Record<string, unknown> = {};

    const putScalar = (key: FieldKey, target: Record<string, unknown>) => {
      const raw = strOf(key);
      if (!raw) {
        return;
      }
      if (NUMERIC_FIELDS.has(key)) {
        const n = Number(raw);
        if (Number.isFinite(n)) {
          target[key] = n;
        }
      } else {
        target[key] = raw;
      }
    };

    if (action === "add_vehicle") {
      const lookup = strOf("lookup");
      if (lookup) params.lookup = lookup;
      const vehicleId = strOf("vehicleId");
      if (vehicleId && Number.isFinite(Number(vehicleId))) {
        params.vehicleId = Number(vehicleId);
      }
      const notes = strOf("notes");
      if (notes) params.notes = notes;
      const vehicle: Record<string, unknown> = {};
      for (const key of fields) {
        if (VEHICLE_OBJECT_FIELDS.has(key)) {
          putScalar(key, vehicle);
        }
      }
      if (Object.keys(vehicle).length > 0) {
        params.vehicle = vehicle;
      }
      return params;
    }

    if (action === "add_person") {
      const lookup = strOf("lookup");
      if (lookup) params.lookup = lookup;
      const personId = strOf("personId");
      if (personId && Number.isFinite(Number(personId))) {
        params.personId = Number(personId);
      }
      const relation = strOf("relation");
      if (relation) params.relation = relation;
      const notes = strOf("notes");
      if (notes) params.notes = notes;
      const person: Record<string, unknown> = {};
      for (const key of fields) {
        if (PERSON_OBJECT_FIELDS.has(key)) {
          putScalar(key, person);
        }
      }
      if (Object.keys(person).length > 0) {
        params.person = person;
      }
      return params;
    }

    if (action === "create_incident") {
      // The New Incident API expects `type`; map our createType field onto it.
      const type = strOf("createType");
      if (type) params.type = type;
      const priority = strOf("priority");
      if (priority) params.priority = priority;
      const location = strOf("location");
      if (location) params.location = location;
      const units = strOf("units");
      if (units) params.units = units;
      return params;
    }

    // Generic flat actions (search, list, get, removes, comments, tags).
    for (const key of fields) {
      putScalar(key, params);
    }
    return params;
  }

  async function run() {
    setError(null);
    setRunning(true);
    setResult(null);
    try {
      const res = await api.ten8ApiTest({ action, params: buildParams() });
      setResult(res);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="ai-test-panel">
      <header className="ai-test-header">
        <h2>10-8 CAD API Tester</h2>
        <p className="muted">
          Exercise each 10-8 CAD Incident API (v1.1.0) function individually and see the raw JSON
          response. Searches and other reads run live against 10-8. WRITE actions (add / remove /
          create / update) only hit 10-8 for real when the agency has <b>10-8 live CAD writes</b>{" "}
          enabled — otherwise they shadow, and the response will show <code>shadow: true</code> with
          the sanitized body that would have been sent.
        </p>
      </header>

      <section className="ai-test-form">
        <label>
          <span>Action</span>
          <select
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setResult(null);
              setError(null);
            }}
          >
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
                {a.write ? " · WRITE" : ""}
              </option>
            ))}
          </select>
        </label>

        {fields.length === 0 ? (
          <p className="muted">No parameters — just run it.</p>
        ) : (
          <div className="ai-test-meta">
            {fields.map((key) => (
              <label key={key}>
                <span>{FIELD_LABELS[key]}</span>
                {TEXTAREA_FIELDS.has(key) ? (
                  <textarea
                    value={values[key] ?? ""}
                    onChange={(e) => setField(key, e.target.value)}
                    rows={3}
                  />
                ) : (
                  <input
                    type="text"
                    inputMode={NUMERIC_FIELDS.has(key) ? "numeric" : "text"}
                    value={values[key] ?? ""}
                    onChange={(e) => setField(key, e.target.value)}
                  />
                )}
              </label>
            ))}
          </div>
        )}

        <div className="ai-test-run">
          <button
            type="button"
            className={"ai-test-run-btn" + (isWrite ? " danger" : "")}
            onClick={run}
            disabled={running}
          >
            {running ? "Running…" : isWrite ? "Run (write — shadows unless live)" : "Run"}
          </button>
          {error && <span className="ai-test-error">{error}</span>}
        </div>
      </section>

      {result && (
        <section className="ai-test-result">
          <div className="ai-test-summary-row">
            <span className={"ai-test-pill " + (result.ok ? "ok" : "warn")}>
              ok: <b>{String(result.ok)}</b>
            </span>
            {result.status != null && (
              <span className="ai-test-pill">status: {result.status}</span>
            )}
            <span className={"ai-test-pill " + (result.shadow ? "warn" : "ok")}>
              shadow: <b>{String(result.shadow === true)}</b>
            </span>
          </div>

          <div className="ai-test-section">
            <h3>Raw response</h3>
            <pre className="ai-test-json">{JSON.stringify(result.data, null, 2)}</pre>
          </div>
        </section>
      )}
    </div>
  );
}
