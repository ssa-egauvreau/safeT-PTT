// Typed client for the Security Radio API. All calls are same-origin (the Node server serves this app).

export type Role = "admin" | "dispatcher" | "radio";
export type Permission = "talk_priority" | "talk" | "listen_only";

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  unitId: string | null;
}

export interface AdminUser {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  unit_id: string | null;
  disabled: boolean;
  created_at: string;
}

export interface Channel {
  id: number;
  name: string;
  sort_order: number;
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
  login: (username: string, password: string) =>
    request<{ token: string; user: SessionUser }>("POST", "/v1/auth/login", { username, password }),
  me: () => request<{ user: SessionUser }>("GET", "/v1/auth/me"),
  myChannels: () => request<{ channels: UserChannel[] }>("GET", "/v1/me/channels"),

  listUsers: () => request<{ users: AdminUser[] }>("GET", "/v1/admin/users"),
  createUser: (input: { username: string; displayName: string; password: string; role: Role; unitId: string | null }) =>
    request<{ user: AdminUser }>("POST", "/v1/admin/users", input),
  updateUser: (
    id: number,
    patch: Partial<{ displayName: string; role: Role; unitId: string | null; disabled: boolean; password: string }>,
  ) => request<{ user: AdminUser }>("PATCH", `/v1/admin/users/${id}`, patch),
  deleteUser: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/admin/users/${id}`),

  listChannels: () => request<{ channels: Channel[] }>("GET", "/v1/admin/channels"),
  createChannel: (name: string) => request<{ channel: Channel }>("POST", "/v1/admin/channels", { name }),
  renameChannel: (id: number, name: string) => request<{ channel: Channel }>("PATCH", `/v1/admin/channels/${id}`, { name }),
  deleteChannel: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/admin/channels/${id}`),

  listMemberships: () => request<{ memberships: Membership[] }>("GET", "/v1/admin/memberships"),
  setMembership: (userId: number, channelId: number, permission: Permission) =>
    request<{ ok: boolean }>("PUT", "/v1/admin/memberships", { userId, channelId, permission }),
  removeMembership: (userId: number, channelId: number) =>
    request<{ ok: boolean }>("DELETE", `/v1/admin/memberships?userId=${userId}&channelId=${channelId}`),

  listAudit: (limit = 200) => request<{ entries: AuditEntry[] }>("GET", `/v1/admin/audit?limit=${limit}`),
};

/** Human-readable copy for the API error codes the UI can surface. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const map: Record<string, string> = {
      invalid_login: "Incorrect username or password.",
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
    };
    return map[error.message] ?? `Request failed (${error.message}).`;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
