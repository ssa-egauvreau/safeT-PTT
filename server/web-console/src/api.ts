// Typed client for the safeT PTT API. All calls are same-origin (the Node server serves this app).

export type Role = "owner" | "admin" | "dispatcher" | "radio";
export type Permission = "talk_priority" | "talk" | "listen_only";

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  unitId: string | null;
  agencyId: number | null;
  agencyName: string | null;
}

export interface AdminUser {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  unit_id: string | null;
  device_type: string | null;
  disabled: boolean;
  agency_id: number | null;
  created_at: string;
}

/** Device categories an admin can assign to an account. */
export const DEVICE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "—" },
  { value: "unit_radio", label: "Unit radio (in-car)" },
  { value: "handheld", label: "Handheld (pacset)" },
  { value: "dispatch_console", label: "Dispatch console" },
  { value: "phone", label: "Phone" },
  { value: "radio_bridge", label: "Radio bridge" },
];

export function deviceTypeLabel(value: string | null): string {
  return DEVICE_TYPE_OPTIONS.find((o) => o.value === (value ?? ""))?.label ?? "—";
}

/** Window event fired when the agency logo is uploaded or removed, so the top bar can refresh. */
export const AGENCY_LOGO_CHANGED_EVENT = "safet:agency-logo-changed";

export interface Agency {
  id: number;
  name: string;
  slug: string;
  radio_key: string | null;
  disabled: boolean;
  created_at: string;
  /** Present on the owner agency listing; omitted on create/update responses. */
  user_count?: number;
  channel_count?: number;
}

export interface Channel {
  id: number;
  name: string;
  sort_order: number;
  color: string | null;
  zone: string | null;
}

export interface Membership {
  user_id: number;
  channel_id: number;
  permission: Permission;
}

export interface UserChannel {
  id: number;
  name: string;
  permission: Permission;
  color: string | null;
  zone: string | null;
  /** True for a simulcast channel — keying it transmits on several real channels. */
  simulcast?: boolean;
}

export interface Simulcast {
  id: number;
  name: string;
  member_channel_ids: number[];
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor_user_id: number | null;
  actor_name: string | null;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
}

export interface Transmission {
  id: number;
  channel_id: number | null;
  channel_name: string;
  user_id: number | null;
  unit_id: string | null;
  display_name: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  sample_rate: number;
  audio_mime: string;
  transcript: string | null;
  transcript_status: string;
}

export interface RadioPosition {
  unit_id: string;
  user_id: number | null;
  display_name: string | null;
  channel_name: string | null;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  heading: number | null;
  speed_mps: number | null;
  /** Device category of the reporting account (handheld, unit_radio, …), or null. */
  device_type: string | null;
  updated_at: string;
}

/** One recorded GPS fix from a radio's position history. */
export interface PositionSample {
  lat: number;
  lon: number;
  accuracy_m: number | null;
  heading: number | null;
  speed_mps: number | null;
  recorded_at: string;
}

/** A map overlay zone drawn by an operator — a circle or a custom polygon. */
export interface Geofence {
  id: number;
  name: string;
  shape: string;
  color: string | null;
  center_lat: number | null;
  center_lon: number | null;
  radius_m: number | null;
  /** Polygon vertices as [lat, lon] pairs; null for a circle geofence. */
  points: [number, number][] | null;
  created_by: string | null;
  created_at: string;
}

export type GeofenceInput =
  | { shape: "circle"; name: string; centerLat: number; centerLon: number; radiusM: number; color?: string | null }
  | { shape: "polygon"; name: string; points: [number, number][]; color?: string | null };

export interface Alert {
  id: number;
  kind: string;
  channel_name: string | null;
  target_unit: string | null;
  from_user_id: number | null;
  from_name: string | null;
  from_unit: string | null;
  message: string | null;
  active: boolean;
  created_at: string;
  cleared_by: string | null;
  cleared_at: string | null;
}

export interface ChannelMember {
  unit_id: string;
  display_name: string | null;
  kind: string;
  /** Client platform: android, ios, web, desktop, bridge, or unknown. */
  client: string;
  connected_ms: number;
}

export interface UnitAlias {
  unit_id: string;
  label: string;
  updated_at: string;
}

export interface AgencySound {
  kind: string;
  mime: string;
  byte_size: number;
  updated_at: string;
}

export interface Bridge {
  id: number;
  name: string;
  source_type: string;
  source_url: string | null;
  device_hint: string | null;
  target_channel: string;
  direction: string;
  yield_to_units: boolean;
  tx_mode: string;
  vox_threshold: number;
  vox_hang_ms: number;
  enabled: boolean;
  created_at: string;
}

export interface BridgeInput {
  name: string;
  sourceType: string;
  sourceUrl: string | null;
  deviceHint: string | null;
  targetChannel: string;
  direction: string;
  yieldToUnits: boolean;
  txMode: string;
  voxThreshold: number;
  voxHangMs: number;
  enabled: boolean;
}

export class ApiError extends Error {
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = "ApiError";
    this.status = status;
  }
}

let authToken: string | null = null;

export function setToken(token: string | null): void {
  authToken = token;
}

/** Current bearer token, for transports that cannot send headers (the voice WebSocket). */
export function getToken(): string | null {
  return authToken;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!res.ok) {
    const code = (data as { error?: string })?.error ?? `http_${res.status}`;
    throw new ApiError(code, res.status);
  }
  return data as T;
}

export const api = {
  login: (username: string, password: string, agencySlug?: string) =>
    request<{ token: string; user: SessionUser }>("POST", "/v1/auth/login", {
      username,
      password,
      ...(agencySlug?.trim() ? { agency_slug: agencySlug.trim().toLowerCase() } : {}),
    }),
  me: () => request<{ user: SessionUser }>("GET", "/v1/auth/me"),
  myChannels: () => request<{ channels: UserChannel[] }>("GET", "/v1/me/channels"),

  listUsers: () => request<{ users: AdminUser[] }>("GET", "/v1/admin/users"),
  createUser: (input: {
    username: string;
    displayName: string;
    password: string;
    role: Role;
    unitId: string | null;
    deviceType: string | null;
  }) => request<{ user: AdminUser }>("POST", "/v1/admin/users", input),
  updateUser: (
    id: number,
    patch: Partial<{
      displayName: string;
      role: Role;
      unitId: string | null;
      deviceType: string | null;
      disabled: boolean;
      password: string;
    }>,
  ) => request<{ user: AdminUser }>("PATCH", `/v1/admin/users/${id}`, patch),
  deleteUser: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/admin/users/${id}`),

  listChannels: () => request<{ channels: Channel[] }>("GET", "/v1/admin/channels"),
  createChannel: (name: string) => request<{ channel: Channel }>("POST", "/v1/admin/channels", { name }),
  updateChannel: (id: number, patch: { name?: string; color?: string | null; zone?: string | null }) =>
    request<{ channel: Channel }>("PATCH", `/v1/admin/channels/${id}`, patch),
  deleteChannel: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/admin/channels/${id}`),

  listMemberships: () => request<{ memberships: Membership[] }>("GET", "/v1/admin/memberships"),
  setMembership: (userId: number, channelId: number, permission: Permission) =>
    request<{ ok: boolean }>("PUT", "/v1/admin/memberships", { userId, channelId, permission }),
  removeMembership: (userId: number, channelId: number) =>
    request<{ ok: boolean }>("DELETE", `/v1/admin/memberships?userId=${userId}&channelId=${channelId}`),

  listAudit: (limit = 200) => request<{ entries: AuditEntry[] }>("GET", `/v1/admin/audit?limit=${limit}`),

  transmissions: (
    opts: {
      limit?: number;
      search?: string;
      channel?: string;
      user?: string;
      from?: string;
      to?: string;
      sort?: string;
    } = {},
  ) => {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
    for (const key of ["search", "channel", "user", "from", "to", "sort"] as const) {
      const value = opts[key]?.trim();
      if (value) {
        params.set(key, value);
      }
    }
    return request<{ transmissions: Transmission[] }>("GET", `/v1/transmissions?${params}`);
  },

  locations: () => request<{ positions: RadioPosition[] }>("GET", "/v1/locations"),
  locationHistory: (unit: string, from?: string, to?: string) => {
    const params = new URLSearchParams({ unit });
    if (from) {
      params.set("from", from);
    }
    if (to) {
      params.set("to", to);
    }
    return request<{ unit: string; samples: PositionSample[] }>(
      "GET",
      `/v1/locations/history?${params}`,
    );
  },

  geofences: () => request<{ geofences: Geofence[] }>("GET", "/v1/geofences"),
  createGeofence: (input: GeofenceInput) =>
    request<{ geofence: Geofence }>("POST", "/v1/geofences", input),
  deleteGeofence: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/geofences/${id}`),

  alerts: () => request<{ alerts: Alert[] }>("GET", "/v1/alerts"),
  sendAlert: (input: { kind: string; channelName: string | null; targetUnit?: string | null; message: string | null }) =>
    request<{ alert: Alert }>("POST", "/v1/alerts", input),
  clearAlert: (id: number) => request<{ alert: Alert }>("POST", `/v1/alerts/${id}/clear`),

  /** Toggles the 10-33 channel marker so radios on that channel show a warning icon. */
  setChannelTen33: (channelName: string, active: boolean) =>
    request<{ ok: boolean }>("POST", "/v1/channels/ten33", { channel: channelName, active }),

  channelRoster: (channel: string) =>
    request<{ members: ChannelMember[] }>("GET", `/v1/channels/roster?channel=${encodeURIComponent(channel)}`),

  unitAliases: () => request<{ aliases: UnitAlias[] }>("GET", "/v1/unit-aliases"),
  setUnitAlias: (unitId: string, label: string) =>
    request<{ alias: UnitAlias }>("PUT", "/v1/admin/unit-aliases", { unitId, label }),
  deleteUnitAlias: (unitId: string) =>
    request<{ ok: boolean }>("DELETE", `/v1/admin/unit-aliases/${encodeURIComponent(unitId)}`),

  // --- owner: agencies (platform tenants) --------------------------------
  listAgencies: () => request<{ agencies: Agency[] }>("GET", "/v1/owner/agencies"),
  createAgency: (input: {
    name: string;
    adminUsername: string;
    adminDisplayName: string;
    adminPassword: string;
  }) => request<{ agency: Agency; admin: AdminUser }>("POST", "/v1/owner/agencies", input),
  updateAgency: (id: number, patch: { name?: string; disabled?: boolean; regenerateRadioKey?: boolean }) =>
    request<{ agency: Agency }>("PATCH", `/v1/owner/agencies/${id}`, patch),
  deleteAgency: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/owner/agencies/${id}`),

  agencyUsers: (id: number) => request<{ users: AdminUser[] }>("GET", `/v1/owner/agencies/${id}/users`),
  createAgencyUser: (
    id: number,
    input: {
      username: string;
      displayName: string;
      password: string;
      role: Role;
      unitId: string | null;
      deviceType: string | null;
    },
  ) => request<{ user: AdminUser }>("POST", `/v1/owner/agencies/${id}/users`, input),
  updateAgencyUser: (
    id: number,
    uid: number,
    patch: Partial<{
      displayName: string;
      role: Role;
      unitId: string | null;
      deviceType: string | null;
      disabled: boolean;
      password: string;
    }>,
  ) => request<{ user: AdminUser }>("PATCH", `/v1/owner/agencies/${id}/users/${uid}`, patch),
  deleteAgencyUser: (id: number, uid: number) =>
    request<{ ok: boolean }>("DELETE", `/v1/owner/agencies/${id}/users/${uid}`),

  // --- custom radio tones ------------------------------------------------
  listSounds: () => request<{ sounds: AgencySound[] }>("GET", "/v1/admin/sounds"),
  deleteSound: (kind: string) =>
    request<{ ok: boolean }>("DELETE", `/v1/admin/sounds/${encodeURIComponent(kind)}`),

  // --- agency branding ---------------------------------------------------
  deleteAgencyLogo: () => request<{ ok: boolean }>("DELETE", "/v1/admin/agency/logo"),

  // --- radio bridges -----------------------------------------------------
  listBridges: () => request<{ bridges: Bridge[] }>("GET", "/v1/admin/bridges"),
  createBridge: (input: BridgeInput) => request<{ bridge: Bridge }>("POST", "/v1/admin/bridges", input),
  updateBridge: (id: number, patch: Partial<BridgeInput>) =>
    request<{ bridge: Bridge }>("PATCH", `/v1/admin/bridges/${id}`, patch),
  deleteBridge: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/admin/bridges/${id}`),
  /** Enabled audio-device bridges this agency can run from the desktop console. */
  listRunnableBridges: () => request<{ bridges: Bridge[] }>("GET", "/v1/bridges/runnable"),

  // --- simulcast channels ------------------------------------------------
  listSimulcasts: () => request<{ simulcasts: Simulcast[] }>("GET", "/v1/simulcast"),
  createSimulcast: (name: string, channelIds: number[]) =>
    request<{ simulcast: { id: number; name: string } }>("POST", "/v1/simulcast", { name, channelIds }),
  updateSimulcast: (id: number, patch: { name?: string; channelIds?: number[] }) =>
    request<{ ok: boolean }>("PUT", `/v1/simulcast/${id}`, patch),
  deleteSimulcast: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/simulcast/${id}`),
};

/** Uploads a custom agency logo (raw image body — not JSON). */
export async function uploadAgencyLogo(file: File): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": file.type || "image/png" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch("/v1/admin/agency/logo", { method: "PUT", headers, body: file });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      code = (JSON.parse(await res.text()) as { error?: string }).error ?? code;
    } catch {
      /* keep the generic code */
    }
    throw new ApiError(code, res.status);
  }
}

/** Uploads a custom tone for one sound kind (raw audio body — not JSON). */
export async function uploadSound(kind: string, file: File): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": file.type || "audio/wav" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(`/v1/admin/sounds/${encodeURIComponent(kind)}`, {
    method: "PUT",
    headers,
    body: file,
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      code = (JSON.parse(await res.text()) as { error?: string }).error ?? code;
    } catch {
      /* keep the generic code */
    }
    throw new ApiError(code, res.status);
  }
}

/** Fetches a transmission's WAV audio as a Blob (a bearer header cannot ride on <audio src>). */
export async function fetchTransmissionAudio(id: number): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(`/v1/transmissions/${id}/audio`, { headers });
  if (!res.ok) {
    throw new ApiError(`http_${res.status}`, res.status);
  }
  return res.blob();
}

/** Human-readable copy for the API error codes the UI can surface. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const map: Record<string, string> = {
      invalid_login: "Incorrect username or password.",
      owner_use_platform_portal: "Platform owner accounts sign in without an agency code, from the Platform portal.",
      missing_credentials: "Enter a username and password.",
      missing_fields: "Fill in every required field.",
      missing_name: "Enter a name.",
      username_taken: "That username is already in use.",
      duplicate: "That name is already in use.",
      last_admin: "You cannot remove the last administrator.",
      cannot_delete_self: "You cannot delete your own account.",
      not_found: "That item no longer exists.",
      forbidden: "You do not have access to that.",
      unauthorized: "Your session expired — sign in again.",
      database_unavailable: "The database is not configured on the server.",
      bad_role: "Unknown role.",
      agency_disabled: "Your agency has been disabled. Contact your platform owner.",
    };
    return map[error.message] ?? `Request failed (${error.message}).`;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
