import type { MainCategory, Prisma } from "@prisma/client";
import type { AllocationView } from "@contracts";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { getSetting } from "@/lib/settings";
import { ENGAGEMENT_STAGES, engagementTier } from "@contracts/shared/engagement";
import type { UserActor } from "@/platform/endpoint";
import { pickAssignee, teamMembers } from "@/modules/users/assignment";
import { tierDays } from "@/modules/engagement/service";
import { PENDING_ALLOCATION, canAllocate } from "./service";

const PAGE_SIZE = 50;

/** The Team 3 leader's pool of qualified leads waiting for a Team 2 sourcer, by category. */
export async function getAllocation(actor: UserActor, opts: { category?: MainCategory | "NONE"; page?: number }): Promise<AllocationView> {
  const page = Math.max(1, opts.page ?? 1);
  const category = opts.category ?? null;
  const where: Prisma.CandidateWhereInput = { ...PENDING_ALLOCATION, ...(category ? { mainCategory: category === "NONE" ? null : category } : {}) };
  const t = now();

  const [groups, total, pending, members, loads, recent, tiers] = await Promise.all([
    prisma.candidate.groupBy({ by: ["mainCategory"], where: PENDING_ALLOCATION, _count: { _all: true } }),
    prisma.candidate.count({ where }),
    prisma.candidate.findMany({ where, include: { owner: { select: { name: true } } }, orderBy: { stageChangedAt: "asc" }, take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE }),
    teamMembers("T2"),
    prisma.candidate.groupBy({ by: ["ownerUserId"], where: { stage: { in: ENGAGEMENT_STAGES }, anonymizedAt: null, NOT: PENDING_ALLOCATION }, _count: { _all: true } }),
    prisma.candidate.findMany({
      where: { allocatedById: { not: null }, anonymizedAt: null },
      select: { id: true, name: true, candidateCode: true, mainCategory: true, allocatedAt: true, allocatedById: true, stage: true, owner: { select: { name: true } } },
      orderBy: { allocatedAt: "desc" },
      take: 15,
    }),
    getSetting("engagementTierDays"),
  ]);

  const loadOf = new Map(loads.map((l) => [l.ownerUserId, l._count._all]));
  const allocators = await prisma.user.findMany({ where: { id: { in: [...new Set(recent.map((r) => r.allocatedById!))] } }, select: { id: true, name: true } });
  const allocatorName = new Map(allocators.map((u) => [u.id, u.name]));
  const days = tierDays({ engagementTierDays: tiers });

  const categories = await Promise.all(
    groups
      .sort((a, b) => b._count._all - a._count._all)
      .map(async (g) => ({ category: g.mainCategory, pending: g._count._all, suggestedSourcerId: await pickAssignee("T2", g.mainCategory) })),
  );

  return {
    canAllocate: canAllocate(actor),
    category,
    page,
    pageSize: PAGE_SIZE,
    total,
    categories,
    sourcers: members.map((u) => {
      const t2 = u.roles.filter((r) => r.team.code === "T2");
      return {
        id: u.id,
        name: u.name,
        category: t2.find((r) => r.category)?.category ?? null,
        isLeader: t2.some((r) => r.role === "team2_leader"),
        load: loadOf.get(u.id) ?? 0,
      };
    }),
    pending: pending.map((c) => ({
      id: c.id,
      name: c.name,
      candidateCode: c.candidateCode,
      mainCategory: c.mainCategory,
      primarySpecialty: c.primarySpecialty,
      jobTitle: c.jobTitle,
      currentLocation: c.currentLocation,
      experienceYears: c.experienceYears,
      stageChangedAt: c.stageChangedAt,
      lastEngagedAt: c.lastEngagedAt,
      tier: engagementTier(c.lastEngagedAt, t, days),
      owner: c.owner,
    })),
    recent: recent.map(({ allocatedById, ...r }) => ({ ...r, allocatedBy: allocatorName.get(allocatedById!) ?? null })),
  };
}
