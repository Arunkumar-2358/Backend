import type { MainCategory, Prisma } from "@prisma/client";
import type { ColdCallsView } from "@contracts";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { getAllSettings } from "@/lib/settings";
import { engagementTier } from "@contracts/shared/engagement";
import { startOfIstDay } from "@contracts/shared/dates";
import type { UserActor } from "@/platform/endpoint";
import { pickAssignee, teamMembers } from "@/modules/users/assignment";
import { tierDays } from "@/modules/engagement/service";
import { canAllocateColdCalls, coldPoolWhere } from "./service";

const PAGE_SIZE = 25;
const POOL_PAGE_SIZE = 50;

/** The caller's open cold-lead calls (or the whole team's for the leader), plus the leader's allocation pool. */
export async function getColdCalls(actor: UserActor, opts: { scope?: "mine" | "team"; page?: number; category?: MainCategory | "NONE" }): Promise<ColdCallsView> {
  const isLeader = canAllocateColdCalls(actor);
  const scope = isLeader && opts.scope === "team" ? "team" : "mine";
  const page = Math.max(1, opts.page ?? 1);
  const t = now();
  const settings = await getAllSettings();
  const days = tierDays(settings);

  const mine = scope === "mine" ? { assigneeId: actor.id } : {};
  const where: Prisma.TaskWhereInput = { type: "COLD_CALL", status: "OPEN", ...mine };
  const dayStart = startOfIstDay(t);
  const callsToday: Prisma.ContactAttemptWhereInput = { coldCall: true, at: { gte: dayStart }, ...(scope === "mine" ? { byUserId: actor.id } : {}) };

  const [tasks, total, allocated, calls, answered, superActive] = await Promise.all([
    prisma.task.findMany({
      where,
      include: {
        assignee: { select: { name: true } },
        candidate: { include: { owner: { select: { name: true } } } },
      },
      orderBy: { dueAt: "asc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    prisma.task.count({ where }),
    prisma.task.count({ where: { type: "COLD_CALL", createdAt: { gte: dayStart }, ...mine } }),
    prisma.contactAttempt.count({ where: callsToday }),
    prisma.contactAttempt.count({ where: { ...callsToday, outcome: { not: "UNANSWERED" } } }),
    prisma.contactAttempt.count({ where: { ...callsToday, outcome: "NEEDS_JOB" } }),
  ]);

  // Calls already made on each open allocation (since its task was created).
  const attempts = await Promise.all(
    tasks.map((task) =>
      prisma.contactAttempt.findMany({ where: { candidateId: task.candidateId!, coldCall: true, at: { gte: task.createdAt } }, orderBy: { at: "desc" }, select: { outcome: true, at: true } }),
    ),
  );

  return {
    isLeader,
    scope,
    page,
    pageSize: PAGE_SIZE,
    total,
    maxAttempts: settings.coldCallMaxAttempts,
    today: { allocated, calls, answered, superActive },
    // The task filter requires a candidate (cold calls are always about one), so candidate is present.
    rows: tasks.filter((task) => task.candidate).map((task, i) => {
      const c = task.candidate!;
      return {
        id: task.id,
        dueAt: task.dueAt,
        title: task.title,
        attempt: attempts[i].length + 1,
        assignee: task.assignee,
        candidate: {
          id: c.id,
          name: c.name,
          candidateCode: c.candidateCode,
          mainCategory: c.mainCategory,
          stage: c.stage,
          lastEngagedAt: c.lastEngagedAt,
          lastPlatformVisitAt: c.lastPlatformVisitAt,
          reengageSentAt: c.reengageSentAt,
          tier: engagementTier(c.lastEngagedAt, t, days),
          owner: c.owner,
        },
        lastCall: attempts[i][0] ?? null,
      };
    }),
    pool: isLeader ? await getColdPool(opts.category ?? null) : null,
  };
}

async function getColdPool(category: MainCategory | "NONE" | null): Promise<NonNullable<ColdCallsView["pool"]>> {
  const pool = await coldPoolWhere();
  const where: Prisma.CandidateWhereInput = category ? { AND: [pool, { mainCategory: category === "NONE" ? null : category }] } : pool;
  const [groups, total, leads, members, open] = await Promise.all([
    prisma.candidate.groupBy({ by: ["mainCategory"], where: pool, _count: { _all: true } }),
    prisma.candidate.count({ where }),
    prisma.candidate.findMany({
      where,
      select: { id: true, name: true, candidateCode: true, mainCategory: true, stage: true, lastEngagedAt: true, reengageSentAt: true, owner: { select: { name: true } } },
      orderBy: [{ lastEngagedAt: { sort: "desc", nulls: "last" } }, { candidateCode: "asc" }],
      take: POOL_PAGE_SIZE,
    }),
    teamMembers("T2"),
    prisma.task.groupBy({ by: ["assigneeId"], where: { type: "COLD_CALL", status: "OPEN" }, _count: { _all: true } }),
  ]);
  const openOf = new Map(open.map((o) => [o.assigneeId, o._count._all]));
  return {
    category,
    total,
    categories: await Promise.all(
      groups
        .sort((a, b) => b._count._all - a._count._all)
        .map(async (g) => ({ category: g.mainCategory, waiting: g._count._all, suggestedCallerId: await pickAssignee("T2", g.mainCategory) })),
    ),
    callers: members.map((u) => {
      const t2 = u.roles.filter((r) => r.team.code === "T2");
      return { id: u.id, name: u.name, category: t2.find((r) => r.category)?.category ?? null, isLeader: t2.some((r) => r.role === "team2_leader"), openCalls: openOf.get(u.id) ?? 0 };
    }),
    leads,
  };
}
