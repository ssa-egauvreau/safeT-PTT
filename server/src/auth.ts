import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";

export type Role = "owner" | "admin" | "dispatcher" | "radio";

const ROLE_VALUES: Role[] = ["owner", "admin", "dispatcher", "radio"];

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  unitId: string | null;
  /** Tenant the account belongs to; null for platform `owner` accounts. */
  agencyId: number | null;
  agencyName: string | null;
  /**
   * Session generation written on the originating login. Compared against the
   * user row's current `token_generation` so a later login on another device
   * invalidates this token (newest sign-in wins). Tokens issued before this
   * field existed parse as 0 — they keep working until the user re-logs in.
   */
  gen: number;
}

/** Agency resolved for a request (from a JWT, or a handset's radio key). */
export interface AgencyContext {
  id: number;
  name: string;
  slug: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      agency?: AgencyContext;
    }
  }
}

const envSecret = process.env.JWT_SECRET?.trim();
const JWT_SECRET = envSecret && envSecret.length > 0 ? envSecret : crypto.randomBytes(48).toString("hex");
if (!envSecret) {
  if (process.env.NODE_ENV === "production") {
    // A random per-process secret in production would silently sign every active session out on
    // every redeploy / restart — exactly the failure mode this guard exists to prevent.
    console.error("FATAL: JWT_SECRET env is not set in production. Refusing to start.");
    process.exit(1);
  }
  console.warn("JWT_SECRET not set — using a random secret; existing sessions break on every restart.");
}

/** Console/admin/owner token lifetime in seconds (12h). Radio handsets never expire. */
export const TOKEN_TTL_SECONDS = 12 * 60 * 60;

/**
 * bcrypt work factor. 12 (~250ms/hash on current hardware) is the modern
 * baseline for credentials guarding emergency comms; the cost is paid only at
 * login and password-set, not on the hot request path. bcrypt stores the cost
 * in the hash, so existing rows hashed at the old factor still verify — they
 * just rehash at the new cost the next time the password is set.
 */
const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export function signToken(user: AuthUser): string {
  const claims = {
    uid: user.id,
    un: user.username,
    dn: user.displayName,
    role: user.role,
    unit: user.unitId,
    aid: user.agencyId,
    an: user.agencyName,
    gen: user.gen,
  };
  // Radio handsets stay signed in until a manual sign-out, so their tokens
  // carry no expiry. Console/admin/owner sessions still expire so a lost
  // dispatch login cannot live forever.
  if (user.role === "radio") {
    return jwt.sign(claims, JWT_SECRET);
  }
  return jwt.sign(claims, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const p = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
    const role = ROLE_VALUES.includes(p.role as Role) ? (p.role as Role) : "radio";
    return {
      id: Number(p.uid),
      username: String(p.un ?? ""),
      displayName: String(p.dn ?? ""),
      role,
      unitId: p.unit == null ? null : String(p.unit),
      agencyId: p.aid == null ? null : Number(p.aid),
      agencyName: p.an == null ? null : String(p.an),
      // Pre-existing tokens without the `gen` claim parse as 0, matching the
      // default value on the `users.token_generation` column at deploy time.
      gen: Number(p.gen ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * "Newest sign-in wins" supersession check, shared by the REST middleware and
 * the voice-WebSocket upgrade handler so the rule lives in exactly one place.
 *
 * A session is superseded when its token's generation is older than the user
 * row's current `token_generation` — EXCEPT for `radio` handsets. Handsets are
 * persistent, shared devices that stay signed in until a manual sign-out (their
 * tokens carry no expiry), so they are never superseded: otherwise signing the
 * same radio account in on another handset / the console silently 401s the
 * first handset — on REST it shows "SYNC FAILED", and on the voice socket it
 * drops audio until a manual log-out/log-in mints a fresh-generation token.
 * Console / admin / owner sessions still supersede normally.
 */
export function isSessionSuperseded(role: Role, tokenGen: number, currentGen: number): boolean {
  if (role === "radio") {
    return false;
  }
  return tokenGen !== currentGen;
}

function bearerToken(req: Request): string | null {
  const header = req.header("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

/** Populates `req.authUser` when a valid bearer token is present; never rejects. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (token) {
    const user = verifyToken(token);
    if (user) {
      req.authUser = user;
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  // An agency admin must be scoped to an agency to manage anything.
  if (req.authUser.role !== "admin" || req.authUser.agencyId == null) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

/** Guards the platform owner portal — agency provisioning across all tenants. */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (req.authUser.role !== "owner") {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}
