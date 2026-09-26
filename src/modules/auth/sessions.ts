/**
 * Refresh-token sessions.
 *
 * A login creates a session family. Each refresh rotates the token: the
 * presented row is marked rotated and a new row (same family) is issued.
 * Presenting a rotated token again means it was copied, so the whole family is
 * revoked — except within a short grace window, because a browser with several
 * tabs (or parallel server renders) can legitimately refresh concurrently.
 *
 * Tokens are "<rowId>.<secret>"; the database stores only SHA-256(secret), so a
 * leaked database cannot be replayed as sessions.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma, type Tx } from "@/lib/db";
import { now, DAY } from "@/lib/clock";
import { env } from "@/config/env";

export const REFRESH_REUSE_GRACE_MS = 20_000;

export type IssuedRefresh = { refreshToken: string; refreshExpiresAt: Date; familyId: string };
export type RefreshOutcome =
  | { ok: true; userId: string; issued: IssuedRefresh }
  | { ok: false; reason: "malformed" | "unknown" | "expired" | "revoked" | "reused" };

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

function sameHash(a: string, b: string) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

type Meta = { userAgent?: string; ip?: string };

async function issue(db: Tx, userId: string, familyId: string | null, absoluteExpiresAt: Date | null, meta: Meta): Promise<IssuedRefresh> {
  const secret = randomBytes(32).toString("base64url");
  const t = now();
  const absolute = absoluteExpiresAt ?? new Date(t.getTime() + env.REFRESH_TOKEN_ABSOLUTE_DAYS * DAY);
  const idle = new Date(t.getTime() + env.REFRESH_TOKEN_IDLE_DAYS * DAY);
  const expiresAt = idle < absolute ? idle : absolute;
  const row = await db.authSession.create({
    data: {
      userId,
      familyId: familyId ?? "pending",
      tokenHash: hash(secret),
      expiresAt,
      absoluteExpiresAt: absolute,
      userAgent: meta.userAgent?.slice(0, 300),
      ip: meta.ip?.slice(0, 64),
    },
  });
  // A new family is identified by its first row.
  if (!familyId) await db.authSession.update({ where: { id: row.id }, data: { familyId: row.id } });
  return { refreshToken: `${row.id}.${secret}`, refreshExpiresAt: expiresAt, familyId: familyId ?? row.id };
}

/** Start a new session family at login. */
export function startSession(userId: string, meta: Meta = {}, db: Tx = prisma) {
  return issue(db, userId, null, null, meta);
}

/** Exchange a refresh token for a new one (rotation with reuse detection). */
export async function rotateRefreshToken(token: string, meta: Meta = {}): Promise<RefreshOutcome> {
  const [id, secret] = token.split(".");
  if (!id || !secret) return { ok: false, reason: "malformed" };
  return prisma.$transaction(async (tx) => {
    // Lock the row so two concurrent refreshes of the same token serialise.
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM auth_sessions WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) return { ok: false as const, reason: "unknown" as const };
    const s = await tx.authSession.findUniqueOrThrow({ where: { id } });
    if (!sameHash(s.tokenHash, hash(secret))) return { ok: false as const, reason: "unknown" as const };
    if (s.revokedAt) return { ok: false as const, reason: "revoked" as const };
    const t = now();
    if (s.expiresAt <= t || s.absoluteExpiresAt <= t) return { ok: false as const, reason: "expired" as const };
    if (s.rotatedAt && t.getTime() - s.rotatedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
      await revokeFamily(s.familyId, "refresh token reuse detected", tx);
      return { ok: false as const, reason: "reused" as const };
    }
    const user = await tx.user.findUnique({ where: { id: s.userId }, select: { active: true } });
    if (!user?.active) {
      await revokeFamily(s.familyId, "user inactive", tx);
      return { ok: false as const, reason: "revoked" as const };
    }
    if (!s.rotatedAt) await tx.authSession.update({ where: { id }, data: { rotatedAt: t } });
    const issued = await issue(tx, s.userId, s.familyId, s.absoluteExpiresAt, meta);
    return { ok: true as const, userId: s.userId, issued };
  });
}

/** True while the session family behind an access token is live (checked on every request). */
export async function isSessionLive(familyId: string, db: Tx = prisma): Promise<boolean> {
  const live = await db.authSession.findFirst({ where: { familyId, revokedAt: null, absoluteExpiresAt: { gt: now() } }, select: { id: true } });
  return !!live;
}

export async function revokeFamily(familyId: string, reason: string, db: Tx = prisma) {
  return db.authSession.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now(), revokedReason: reason } });
}

/** Sign a user out everywhere (password change, deactivation, "log out all devices"). */
export async function revokeUserSessions(userId: string, reason: string, opts: { exceptFamilyId?: string } = {}, db: Tx = prisma): Promise<{ count: number }> {
  const where = { userId, revokedAt: null, ...(opts.exceptFamilyId ? { NOT: { familyId: opts.exceptFamilyId } } : {}) };
  // Count devices (session families), not rows: each refresh adds a row to its family.
  const families = await db.authSession.findMany({ where: { ...where, absoluteExpiresAt: { gt: now() } }, distinct: ["familyId"], select: { familyId: true } });
  await db.authSession.updateMany({ where, data: { revokedAt: now(), revokedReason: reason } });
  return { count: families.length };
}

/** Family of a refresh token, when the token is well-formed and genuine (used by logout). */
export async function familyOf(token: string): Promise<string | null> {
  const [id, secret] = token.split(".");
  if (!id || !secret) return null;
  const s = await prisma.authSession.findUnique({ where: { id } });
  return s && sameHash(s.tokenHash, hash(secret)) ? s.familyId : null;
}

/** Housekeeping: drop rows that can never be used again (run daily by the scheduler). */
export async function purgeDeadSessions(olderThanDays = 30, db: Tx = prisma) {
  const cutoff = new Date(now().getTime() - olderThanDays * DAY);
  return db.authSession.deleteMany({ where: { OR: [{ absoluteExpiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] } });
}
