import { prisma, type Tx } from "@/lib/db";
import { now } from "@/lib/clock";
import type { Actor } from "@/lib/rbac";

export type NotificationKind = "TASK" | "LEAD_ASSIGNED" | "RED_FLAG" | "CAPA" | "IMPORT" | "INTERVIEW" | "SYSTEM";
export type NewNotification = { kind: NotificationKind; title: string; body?: string | null; link?: string | null };

/** Bulk flows (imports) send one summary instead of a notification per lead. */
export function isBulkActor(actor: Actor) {
  return actor.kind === "system" && ["import", "zoho-migration", "seed"].includes(actor.label);
}

/** Notify one or more users, skipping nulls, duplicates and the person who caused the event. */
export async function notify(userIds: (string | null | undefined)[] | string | null | undefined, n: NewNotification, db: Tx = prisma, actor?: Actor) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter((x): x is string => !!x))].filter(
    (id) => !(actor?.kind === "user" && actor.id === id),
  );
  if (!ids.length) return 0;
  await db.notification.createMany({ data: ids.map((userId) => ({ userId, kind: n.kind, title: n.title, body: n.body ?? null, link: n.link ?? null, createdAt: now() })) });
  // Best-effort browser/PWA push alongside the in-app bell — never blocks or fails the caller.
  const { pushToUser } = await import("@/modules/push/service");
  await Promise.all(ids.map((userId) => pushToUser(userId, { title: n.title, body: n.body, url: n.link, tag: n.kind }, db).catch(() => {})));
  return ids.length;
}

export async function usersWithRole(roles: string[], teams?: string[], db: Tx = prisma) {
  const rows = await db.userTeamRole.findMany({
    where: { role: { in: roles as never[] }, user: { active: true }, ...(teams ? { team: { code: { in: teams as never[] } } } : {}) },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

export async function unreadCount(userId: string) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function latest(userId: string, take = 8) {
  return prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take });
}

export async function markRead(userId: string, id: string) {
  await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: now() } });
}

export async function markAllRead(userId: string) {
  await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: now() } });
}

export const NOTIFICATIONS_PAGE_SIZE = 30;

export async function listNotifications(userId: string, opts: { page?: number; unread?: boolean; kind?: string }) {
  const page = Math.max(1, opts.page ?? 1);
  const where = { userId, ...(opts.unread ? { readAt: null } : {}), ...(opts.kind ? { kind: opts.kind } : {}) };
  const [rows, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * NOTIFICATIONS_PAGE_SIZE, take: NOTIFICATIONS_PAGE_SIZE }),
    prisma.notification.count({ where }),
    unreadCount(userId),
  ]);
  return { rows, total, unread, page, pageSize: NOTIFICATIONS_PAGE_SIZE };
}
