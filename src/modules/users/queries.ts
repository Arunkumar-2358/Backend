import type { ProfileView } from "@contracts";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { periodRange } from "@contracts/shared/dates";
import type { UserActor } from "@/http/route";

/** The signed-in user's account, team roles and this IST week at a glance. */
export async function getProfile(actor: UserActor): Promise<ProfileView> {
  const t = now();
  const week = periodRange("WEEK", t);
  const [user, openTasks, overdue, owned, byStage, contactsThisWeek, doneThisWeek, attendance, activity] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: actor.id }, include: { roles: { include: { team: true } } } }),
    prisma.task.count({ where: { assigneeId: actor.id, status: "OPEN" } }),
    prisma.task.count({ where: { assigneeId: actor.id, status: "OPEN", dueAt: { lte: t } } }),
    prisma.candidate.count({ where: { ownerUserId: actor.id } }),
    prisma.candidate.groupBy({ by: ["stage"], where: { ownerUserId: actor.id }, _count: true }),
    prisma.contactAttempt.count({ where: { byUserId: actor.id, at: { gte: week.start, lt: week.end } } }),
    prisma.task.count({ where: { assigneeId: actor.id, status: "DONE", completedAt: { gte: week.start, lt: week.end } } }),
    prisma.attendance.count({ where: { userId: actor.id, present: true, date: { gte: week.start, lt: week.end } } }),
    prisma.auditLog.findMany({
      where: { actorId: actor.id, action: { not: "VIEW_PII" } },
      orderBy: { at: "desc" },
      take: 12,
      select: { id: true, at: true, action: true, entityType: true, entityId: true },
    }),
  ]);
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      theme: user.theme,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      roles: user.roles.map((r) => ({ id: r.id, role: r.role, category: r.category, team: { name: r.team.name } })),
    },
    openTasks,
    overdue,
    owned,
    byStage: byStage.map((s) => ({ stage: s.stage, count: s._count })).sort((a, b) => b.count - a.count),
    contactsThisWeek,
    doneThisWeek,
    attendance,
    activity,
  };
}
