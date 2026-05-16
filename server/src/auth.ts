import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";

export type Role = "admin" | "dispatcher" | "radio";

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  unitId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

const envSecret = process.env.JWT_SECRET?.trim();
const JWT_SECRET = envSecret && envSecret.length > 0 ? envSecret : crypto.randomBytes(48).toString("hex");
if (!envSecret) {
  console.warn("JWT_SECRET not set — using a random secret; existing sessions break on every restart.");
}

/** Token lifetime in seconds (12h). */
export const TOKEN_TTL_SECONDS = 12 * 60 * 60;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    { uid: user.id, un: user.username, dn: user.displayName, role: user.role, unit: user.unitId },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL_SECONDS },
  );
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const p = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
    const role = p.role === "admin" || p.role === "dispatcher" ? (p.role as Role) : "radio";
    return {
      id: Number(p.uid),
      username: String(p.un ?? ""),
      displayName: String(p.dn ?? ""),
      role,
      unitId: p.unit == null ? null : String(p.unit),
    };
  } catch {
    return null;
  }
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
  if (req.authUser.role !== "admin") {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}
