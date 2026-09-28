import type { EngagementTier, Prisma } from "@prisma/client";
import type { EngagementView } from "@contracts";
import { prisma } from "@/lib/db";
import { now, DAY } from "@/lib/clock";
import { getSetting } from "@/lib/settings";
import { canReadAll, hasRole, isStageTeamMember, teamsOf } from "@/lib/rbac";
import { ENGAGEMENT_STAGES, ENGAGEMENT_TIERS, engagementTier, engagementWindow, type EngagementTierDays } from "@contracts/shared/engagement";
import type { UserActor } from "@/platform/endpoint";
import { PENDING_ALLOCATION } from "@/modules/allocation/service";
import { REPLY_WINDOW_DAYS, tierDays } from "./service";

const PAGE_SIZE = 25;

export function tierWhere(tier: EngagementTier, at: Date, days: EngagementTierDays): Prisma.CandidateWhereInput {
  const w = engagementWindow(tier, at, days);
  const range: Prisma.DateTimeNullableFilter = { ...(w.from ? { gte: w.from } : {}), ...(w.to ? { lt: w.to } : {}) };
  return w.orNever ? { OR: [{ lastEngagedAt: null }, { lastEngagedAt: range }] } : { lastEngagedAt: range };
}

/** Enrolled + qualified leads by engagement tier: a sourcer's own, or all for leaders / Team 3. */
export async function getEngagement(actor: UserActor, opts: { tier?: EngagementTier; page?: number }): Promise<EngagementView> {
  const page = Math.max(1, opts.page ?? 1);
  const tier = opts.tier ?? null;
  const seesAll = canReadAll(actor) || hasRole(actor, "team2_leader") || teamsOf(actor).some((t) => t.startsWith("T3"));
  const t = now();
  const days = tierDays({ engagementTierDays: await getSetting("engagementTierDays") });

  const base: Prisma.CandidateWhereInput = {
    stage: { in: ENGAGEMENT_STAGES },
    anonymizedAt: null,
    // A sourcer's list holds only the leads the Team 3 leader allocated to them.
    ...(seesAll ? {} : { ownerUserId: actor.id, NOT: PENDING_ALLOCATION }),
  };
  const where: Prisma.CandidateWhereInput = tier ? { AND: [base, tierWhere(tier, t, days)] } : base;
  const replyFrom = new Date(t.getTime() - REPLY_WINDOW_DAYS * DAY);

  const [counts, total, rows, awaitingReply] = await Promise.all([
    Promise.all(ENGAGEMENT_TIERS.map((k) => prisma.candidate.count({ where: { AND: [base, tierWhere(k, t, days)] } }))),
    prisma.candidate.count({ where }),
    prisma.candidate.findMany({
      where,
      include: { owner: { select: { name: true } }, inboundMessages: { orderBy: { receivedAt: "desc" }, take: 1, select: { body: true, intent: true, receivedAt: true } } },
      orderBy: [{ lastEngagedAt: { sort: "desc", nulls: "last" } }, { candidateCode: "asc" }],
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    prisma.candidate.count({
      where: { AND: [base, tierWhere("COLD", t, days)], reengageSentAt: { gte: replyFrom }, inboundMessages: { none: { receivedAt: { gte: replyFrom }, intent: { in: ["LOOKING", "NOT_LOOKING"] } } } },
    }),
  ]);

  return {
    scope: seesAll ? "all" : "mine",
    canAct: isStageTeamMember(actor, "QUALIFIED"),
    tier,
    page,
    pageSize: PAGE_SIZE,
    total,
    days,
    counts: Object.fromEntries(ENGAGEMENT_TIERS.map((k, i) => [k, counts[i]])) as Record<EngagementTier, number>,
    awaitingReply,
    rows: rows.map((c) => ({
      id: c.id,
      name: c.name,
      candidateCode: c.candidateCode,
      mainCategory: c.mainCategory,
      stage: c.stage,
      lastPlatformVisitAt: c.lastPlatformVisitAt,
      jobIntentAt: c.jobIntentAt,
      lastEngagedAt: c.lastEngagedAt,
      reengageSentAt: c.reengageSentAt,
      tier: engagementTier(c.lastEngagedAt, t, days),
      owner: c.owner,
      lastReply: c.inboundMessages[0] ?? null,
    })),
  };
}
