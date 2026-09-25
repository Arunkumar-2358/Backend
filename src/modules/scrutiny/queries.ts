import type { Prisma } from "@prisma/client";
import type { AvailabilityLead, AvailabilityView, ScrutinyTab, ScrutinyView } from "@contracts";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { getSetting } from "@/lib/settings";
import { isStageLeader } from "@/lib/rbac";
import { startOfIstMonth, startOfIstWeek } from "@contracts/shared/dates";
import { completenessPct, missingMandatory } from "@contracts/shared/fields";
import type { UserActor } from "@/http/route";
import { decryptCandidate } from "@/modules/candidates/service";

// ───────────── Availability check-ins ─────────────

const AVAILABILITY_PAGE_SIZE = 25;

const leadInclude = {
  owner: { select: { name: true } },
  availabilityChecks: { orderBy: { checkedAt: "desc" }, take: 1 },
} satisfies Prisma.CandidateInclude;
type LeadRow = Prisma.CandidateGetPayload<{ include: typeof leadInclude }>;

/** Qualified leads (own, or all for the Team 2 leader), due check-ins and cold → warm conversions. */
export async function getAvailability(actor: UserActor, opts: { page?: number; cold?: boolean }): Promise<AvailabilityView> {
  const page = Math.max(1, opts.page ?? 1);
  const coldOnly = !!opts.cold;
  const isLeader = isStageLeader(actor, "QUALIFIED");
  const scope: Prisma.CandidateWhereInput = { anonymizedAt: null, ...(isLeader ? {} : { ownerUserId: actor.id }) };
  const t = now();
  const weekStart = startOfIstWeek(t);
  const monthStart = startOfIstMonth(t);
  const convWhere = (from: Date): Prisma.AvailabilityCheckWhereInput => ({ available: true, wasCold: true, checkedAt: { gte: from }, candidate: scope });
  const qualifiedWhere: Prisma.CandidateWhereInput = { ...scope, stage: "QUALIFIED", ...(coldOnly ? { isCold: true } : {}) };

  const [dueTasks, qualified, qualifiedTotal, coldCount, convWeek, convMonth, recent, interval] = await Promise.all([
    prisma.task.findMany({
      where: { type: "AVAILABILITY_CHECK", status: "OPEN", candidate: scope },
      include: { candidate: { include: leadInclude } },
      orderBy: { dueAt: "asc" },
      take: 200,
    }),
    prisma.candidate.findMany({
      where: qualifiedWhere,
      include: leadInclude,
      orderBy: [{ isCold: "desc" }, { stageChangedAt: "asc" }],
      take: AVAILABILITY_PAGE_SIZE,
      skip: (page - 1) * AVAILABILITY_PAGE_SIZE,
    }),
    prisma.candidate.count({ where: qualifiedWhere }),
    prisma.candidate.count({ where: { ...scope, stage: "QUALIFIED", isCold: true } }),
    prisma.availabilityCheck.count({ where: convWhere(weekStart) }),
    prisma.availabilityCheck.count({ where: convWhere(monthStart) }),
    prisma.availabilityCheck.findMany({
      where: { available: true, wasCold: true, candidate: scope },
      include: { candidate: { select: { id: true, name: true, candidateCode: true, stage: true, isCold: true } } },
      orderBy: { checkedAt: "desc" },
      take: 10,
    }),
    getSetting("availabilityCheckIntervalDays"),
  ]);

  const ids = [...new Set([...qualified.map((c) => c.id), ...dueTasks.map((d) => d.candidateId).filter((x): x is string => !!x)])];
  const jobs = await prisma.scheduledJob.findMany({ where: { status: "PENDING", dedupeKey: { in: ids.map((id) => `avail:${id}`) } }, select: { dedupeKey: true, runAt: true } });
  const nextRun = new Map(jobs.map((j) => [j.dedupeKey!.slice("avail:".length), j.runAt]));
  const checkers = await prisma.user.findMany({ where: { id: { in: recent.map((r) => r.byUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const checkerName = new Map(checkers.map((u) => [u.id, u.name]));

  const view = (c: LeadRow): AvailabilityLead => {
    const last = c.availabilityChecks[0];
    return {
      id: c.id,
      name: c.name,
      candidateCode: c.candidateCode,
      mainCategory: c.mainCategory,
      stage: c.stage,
      isCold: c.isCold,
      coldSince: c.coldSince,
      stageChangedAt: c.stageChangedAt,
      owner: c.owner,
      lastCheck: last ? { checkedAt: last.checkedAt, available: last.available, notes: last.notes } : null,
      nextCheckAt: nextRun.get(c.id) ?? null,
    };
  };

  return {
    isLeader,
    coldOnly,
    page,
    pageSize: AVAILABILITY_PAGE_SIZE,
    interval,
    weekStart,
    monthStart,
    // The task filter requires a candidate in scope, so candidate is always present.
    dueTasks: dueTasks.filter((d) => d.candidate).map((d) => ({ id: d.id, dueAt: d.dueAt, candidate: view(d.candidate!) })),
    qualified: qualified.map(view),
    qualifiedTotal,
    coldCount,
    convWeek,
    convMonth,
    recent: recent.map((r) => ({ id: r.id, checkedAt: r.checkedAt, notes: r.notes, byUserId: r.byUserId, candidate: r.candidate, byName: (r.byUserId && checkerName.get(r.byUserId)) || null })),
  };
}

// ───────────── Enrolment scrutiny ─────────────

const SCRUTINY_PAGE_SIZE = 25;
const SCRUTINY_TABS: ScrutinyTab[] = ["incomplete", "complete", "all"];

/** Enrolled leads (own, or all for the Team 2 leader) with their SOP completeness. */
export async function getScrutiny(actor: UserActor, opts: { tab?: ScrutinyTab; page?: number }): Promise<ScrutinyView> {
  const tab: ScrutinyTab = opts.tab && SCRUTINY_TABS.includes(opts.tab) ? opts.tab : "incomplete";
  const page = Math.max(1, opts.page ?? 1);
  const isLeader = isStageLeader(actor, "ENROLLED");

  const base: Prisma.CandidateWhereInput = { stage: "ENROLLED", anonymizedAt: null, ...(isLeader ? {} : { ownerUserId: actor.id }) };
  const tabWhere: Record<ScrutinyTab, Prisma.CandidateWhereInput> = {
    incomplete: { ...base, profileCompletenessPct: { lt: 100 } },
    complete: { ...base, profileCompletenessPct: { gte: 100 } },
    all: base,
  };
  const [counts, total, leads, mandatory] = await Promise.all([
    Promise.all(SCRUTINY_TABS.map((k) => prisma.candidate.count({ where: tabWhere[k] }))),
    prisma.candidate.count({ where: tabWhere[tab] }),
    prisma.candidate.findMany({
      where: tabWhere[tab],
      include: {
        owner: { select: { name: true } },
        tasks: { where: { type: "COLLECT_DETAILS", status: "OPEN" }, include: { assignee: { select: { name: true } } }, orderBy: { dueAt: "asc" }, take: 1 },
      },
      orderBy: [{ enrolledAt: "asc" }, { createdAt: "asc" }],
      take: SCRUTINY_PAGE_SIZE,
      skip: (page - 1) * SCRUTINY_PAGE_SIZE,
    }),
    getSetting("mandatorySopFields"),
  ]);
  const scrutinizers = await prisma.user.findMany({ where: { id: { in: leads.map((l) => l.scrutinizedById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const nameOf = new Map(scrutinizers.map((u) => [u.id, u.name]));

  return {
    isLeader,
    tab,
    page,
    pageSize: SCRUTINY_PAGE_SIZE,
    counts: { incomplete: counts[0], complete: counts[1], all: counts[2] },
    total,
    mandatory,
    leads: leads.map((lead) => {
      // Decrypted only to test which mandatory fields are filled; no PII leaves the API.
      const plain = decryptCandidate(lead);
      const task = lead.tasks[0];
      return {
        id: lead.id,
        name: lead.name,
        candidateCode: lead.candidateCode,
        mainCategory: lead.mainCategory,
        enrolledAt: lead.enrolledAt,
        stageChangedAt: lead.stageChangedAt,
        scrutinizedAt: lead.scrutinizedAt,
        scrutinizedById: lead.scrutinizedById,
        tlRemarks: lead.tlRemarks,
        owner: lead.owner,
        missing: missingMandatory(plain, mandatory),
        pct: completenessPct(plain, mandatory),
        scrutinizerName: lead.scrutinizedById ? nameOf.get(lead.scrutinizedById) ?? null : null,
        task: task ? { dueAt: task.dueAt, assignee: task.assignee } : null,
      };
    }),
  };
}
