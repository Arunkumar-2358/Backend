import bcrypt from "bcryptjs";
import type { LoginResult } from "@contracts";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { signSession } from "@/lib/session-token";
import { parseThemePref } from "@/lib/theme";

export const SESSION_TTL_SECONDS = 12 * 3600;

/** Verify credentials and mint a session token; null when the credentials are wrong or the user is inactive. */
export async function login(email: string, password: string): Promise<LoginResult | null> {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, include: { roles: true } });
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) return null;
  const roles = [...new Set(user.roles.map((r) => r.role))];
  const token = await signSession({ sub: user.id, name: user.name, roles });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ kind: "user", id: user.id, name: user.name, email: user.email, roles: [] }, "LOGIN", "user", user.id);
  return { token, expiresIn: SESSION_TTL_SECONDS, user: { id: user.id, name: user.name, email: user.email, roles, theme: parseThemePref(user.theme) } };
}
