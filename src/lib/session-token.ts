/** Access token (JWT, HS256, edge-safe so the web middleware can verify it too). */
import { SignJWT, jwtVerify } from "jose";
import type { Role } from "@prisma/client";

export const SESSION_COOKIE = "nt_session";
export const REFRESH_COOKIE = "nt_refresh";

/** `sid` is the session family: revoking it signs every token of that login out. */
export type SessionClaims = { sub: string; name: string; roles: Role[]; sid: string };

const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET ?? "");

const ttlSeconds = () => Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900);

export async function signSession(c: SessionClaims, expiresInSeconds = ttlSeconds()): Promise<string> {
  return new SignJWT({ name: c.name, roles: c.roles, sid: c.sid, typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`)
    .sign(secret());
}

/** Null for a missing, expired, tampered or pre-refresh-token (no `sid`) token. */
export async function verifySession(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (payload.typ !== "access" || typeof payload.sid !== "string" || !payload.sub) return null;
    return { sub: String(payload.sub), name: String(payload.name), roles: (payload.roles as Role[]) ?? [], sid: payload.sid };
  } catch {
    return null;
  }
}
