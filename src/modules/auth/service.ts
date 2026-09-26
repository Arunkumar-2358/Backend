import bcrypt from "bcryptjs";
import type { LoginResult } from "@contracts";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SYSTEM } from "@/lib/rbac";
import { signSession } from "@/lib/session-token";
import { parseThemePref } from "@/lib/theme";
import { env } from "@/config/env";
import { familyOf, revokeFamily, rotateRefreshToken, startSession, type IssuedRefresh } from "./sessions";

type Meta = { userAgent?: string; ip?: string };

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("timing-equaliser-not-a-password", 10);

async function result(userId: string, issued: IssuedRefresh): Promise<LoginResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { roles: true } });
  const roles = [...new Set(user.roles.map((r) => r.role))];
  const token = await signSession({ sub: user.id, name: user.name, roles, sid: issued.familyId }, env.ACCESS_TOKEN_TTL_SECONDS);
  return {
    token,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: issued.refreshToken,
    refreshExpiresAt: issued.refreshExpiresAt.toISOString(),
    user: { id: user.id, name: user.name, email: user.email, roles, theme: parseThemePref(user.theme) },
  };
}

/** Verify credentials and start a session; null when the credentials are wrong or the user is inactive. */
export async function login(email: string, password: string, meta: Meta = {}): Promise<LoginResult | null> {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.active || !ok) {
    if (user) await audit(SYSTEM("auth"), "LOGIN_FAILED", "user", user.id, { ip: meta.ip });
    return null;
  }
  const issued = await startSession(user.id, meta);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ kind: "user", id: user.id, name: user.name, email: user.email, roles: [] }, "LOGIN", "user", user.id, { ip: meta.ip, userAgent: meta.userAgent?.slice(0, 200) });
  return result(user.id, issued);
}

/** Rotate a refresh token into a fresh access + refresh pair; null when the session is over. */
export async function refresh(refreshToken: string, meta: Meta = {}): Promise<LoginResult | null> {
  const r = await rotateRefreshToken(refreshToken, meta);
  if (!r.ok) {
    if (r.reason === "reused") await audit(SYSTEM("auth"), "REFRESH_REUSE", "auth_session", refreshToken.split(".")[0] ?? "", { ip: meta.ip });
    return null;
  }
  return result(r.userId, r.issued);
}

/** Revoke the session family behind a refresh token (idempotent; unknown tokens are ignored). */
export async function logout(refreshToken: string | undefined, fallbackFamilyId?: string) {
  const familyId = (refreshToken && (await familyOf(refreshToken))) || fallbackFamilyId;
  if (familyId) await revokeFamily(familyId, "logout");
}
