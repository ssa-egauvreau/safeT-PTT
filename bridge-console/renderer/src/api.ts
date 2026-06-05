// REST client for the safeT Bridge box. Unlike the web console (which is served
// same-origin), this app targets a configurable dispatch server, so every call
// is built against an explicit base URL.

import type { Bridge, SessionUser, StoredCredentials } from "./types";

export class ApiError extends Error {
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Normalizes a user-typed host into a clean origin, or "" if unparseable. */
export function normalizeServerUrl(input: string): string {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** Derives the WebSocket origin (ws/wss) for a given http(s) server origin. */
export function wsOrigin(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/+$/, "");
}

/** A thin per-server API client holding the current bearer token. */
export class Api {
  readonly serverUrl: string;
  private token: string | null = null;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    const res = await fetch(`${this.serverUrl}${path}`, {
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

  /** Authenticates and stores the returned bearer token. */
  async login(creds: StoredCredentials): Promise<SessionUser> {
    const body: Record<string, unknown> = {
      username: creds.username,
      password: creds.password,
    };
    if (creds.agencySlug?.trim()) {
      body.agency_slug = creds.agencySlug.trim().toLowerCase();
    }
    const out = await this.request<{ token: string; user: SessionUser }>(
      "POST",
      "/v1/auth/login",
      body,
    );
    this.token = out.token;
    return out.user;
  }

  /** Validates the current token, returning the session user. */
  me(): Promise<{ user: SessionUser }> {
    return this.request<{ user: SessionUser }>("GET", "/v1/auth/me");
  }

  /** Enabled audio-device bridges this agency can run from a desktop box. */
  async listRunnableBridges(): Promise<Bridge[]> {
    const out = await this.request<{ bridges: Bridge[] }>("GET", "/v1/bridges/runnable");
    return out.bridges;
  }
}

/** Human copy for the API error codes the bridge UI can surface. */
export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    const map: Record<string, string> = {
      invalid_login: "Incorrect username or password.",
      missing_credentials: "Enter a username and password.",
      agency_disabled: "This agency has been disabled. Contact your platform owner.",
      session_superseded: "Signed in on another device — this box re-authenticated.",
      owner_use_platform_portal: "Owner accounts cannot run bridges. Use an admin/dispatcher login.",
      unauthorized: "Login expired — re-authenticating.",
      forbidden: "This account cannot run that bridge.",
    };
    return map[error.message] ?? `Request failed (${error.message}).`;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** True when an error means the token is no longer valid and we should re-login. */
export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}
