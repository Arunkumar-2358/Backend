/** JWT session token (edge-safe). */
import { SignJWT, jwtVerify } from "jose";
import type { Role } from "@prisma/client";

export const SESSION_COOKIE = "nt_session";
export type SessionClaims = { sub: string; name: string; roles: Role[] };

const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET ?? "dev-only-change-me-0123456789abcdef");

export async function signSession(c: SessionClaims): Promise<string> {
  return new SignJWT({ name: c.name, roles: c.roles }).setProtectedHeader({ alg: "HS256" }).setSubject(c.sub).setIssuedAt().setExpirationTime("12h").sign(secret());
}

export async function verifySession(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return { sub: String(payload.sub), name: String(payload.name), roles: (payload.roles as Role[]) ?? [] };
  } catch {
    return null;
  }
}
