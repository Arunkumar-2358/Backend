import type { Prisma } from "@prisma/client";
import type { LeadCallView, MissedCallInbox, MissedCallView, QueueView } from "@contracts";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { decrypt } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { ForbiddenError, canEditLead, canReadAll, hasRole } from "@/lib/rbac";
import { startOfIstWeek } from "@contracts/shared/dates";
import { notFound } from "@/plugins/errors";
import type { UserActor } from "@/http/route";
import { decryptCandidate, logPiiView } from "@/modules/candidates/service";
import { teamMembers } from "@/modules/users/assignment";

// ───────────── Outreach queue ─────────────

const QUEUE_PAGE_SIZE = 30;
const MINE_CAP = 500;
const OPEN_OUTREACH_TASK = { status: "OPEN", type: { in: ["FOLLOW_UP", "RECALL"] } } satisfies Prisma.TaskWhereInput;

export const QUEUE_ROLES = ["ta_lead", "team1_leader", "telecaller", "admin"] as const;

export async function getQueue(actor: UserActor, opts: { scope?: "mine" | "team"; overdue?: boolean; page?: number }): Promise<QueueView> {
  if (!hasRole(actor, ...QUEUE_ROLES)) throw new ForbiddenError("The outreach queue is for Team 1 (TA leads, tele-callers and their leader).");
  const isLeader = hasRole(actor, "team1_leader", "admin");
  const canAddPortalLead = hasRole(actor, "ta_lead", "team1_leader", "admin");
  const scope = opts.scope === "team" && isLeader ? "team" : "mine";
  const overdueOnly = !!opts.overdue;
  const page = Math.max(1, opts.page ?? 1);
  const t = now();
  const cap = await getSetting("maxContactAttempts");

  const mineWhere: Prisma.CandidateWhereInput = { stage: "VALIDATED", OR: [{ ownerUserId: actor.id }, { tasks: { some: { ...OPEN_OUTREACH_TASK, assigneeId: actor.id } } }] };
  const where: Prisma.CandidateWhereInput = scope === "mine" ? mineWhere : { stage: "VALIDATED" };
  const include = {
    owner: { select: { id: true, name: true } },
    tasks: {
      where: scope === "mine" ? { ...OPEN_OUTREACH_TASK, assigneeId: actor.id } : OPEN_OUTREACH_TASK,
      orderBy: { dueAt: "asc" },
      select: { id: true, dueAt: true, refType: true, assigneeId: true, title: true, assignee: { select: { name: true } } },
    },
    contactAttempts: { orderBy: { at: "desc" }, take: 1, select: { outcome: true, channel: true, at: true } },
  } satisfies Prisma.CandidateInclude;
  type Row = Prisma.CandidateGetPayload<{ include: typeof include }>;

  const dueOf = (c: Row) => {
    const times = [c.tasks[0]?.dueAt, c.nextFollowupAt].filter((d): d is Date => !!d).map((d) => d.getTime());
    return times.length ? Math.min(...times) : null;
  };

  let rows: Row[];
  let total: number;
  if (scope === "mine") {
    // A personal queue is small: load it, sort by the true due time (task or follow-up), paginate in memory.
    const all = await prisma.candidate.findMany({ where, include, orderBy: { nextFollowupAt: { sort: "asc", nulls: "last" } }, take: MINE_CAP });
    const sorted = all
      .filter((c) => !overdueOnly || (dueOf(c) ?? Infinity) <= t.getTime())
      .sort((a, b) => (dueOf(a) ?? Infinity) - (dueOf(b) ?? Infinity));
    total = sorted.length;
    rows = sorted.slice((page - 1) * QUEUE_PAGE_SIZE, page * QUEUE_PAGE_SIZE);
  } else {
    const w: Prisma.CandidateWhereInput = overdueOnly ? { AND: [where, { nextFollowupAt: { lte: t } }] } : where;
    [rows, total] = await Promise.all([
      prisma.candidate.findMany({ where: w, include, orderBy: [{ nextFollowupAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }], skip: (page - 1) * QUEUE_PAGE_SIZE, take: QUEUE_PAGE_SIZE }),
      prisma.candidate.count({ where: w }),
    ]);
    rows.sort((a, b) => (dueOf(a) ?? Infinity) - (dueOf(b) ?? Infinity));
  }

  const [overdueCount, telecallers, firstCallTasks] = await Promise.all([
    scope === "mine"
      ? prisma.candidate.count({ where: { AND: [mineWhere, { OR: [{ nextFollowupAt: { lte: t } }, { tasks: { some: { ...OPEN_OUTREACH_TASK, assigneeId: actor.id, dueAt: { lte: t } } } }] }] } })
      : prisma.candidate.count({ where: { stage: "VALIDATED", nextFollowupAt: { lte: t } } }),
    isLeader && scope === "team" ? teamMembers("T1B") : Promise.resolve([]),
    prisma.task.findMany({ where: { status: "OPEN", assigneeId: actor.id, refType: "first_call", candidateId: { in: rows.map((r) => r.id) } }, select: { candidateId: true } }),
  ]);
  const firstCallFor = new Set(firstCallTasks.map((x) => x.candidateId));

  return {
    scope,
    isLeader,
    canAddPortalLead,
    overdueOnly,
    page,
    pageSize: QUEUE_PAGE_SIZE,
    total,
    overdueCount,
    cap,
    telecallers: telecallers.filter((u) => u.roles.some((r) => r.role === "telecaller")).map((u) => ({ value: u.id, label: u.name })),
    rows: rows.map((c) => {
      const due = dueOf(c);
      return {
        id: c.id,
        name: c.name,
        candidateCode: c.candidateCode,
        mainCategory: c.mainCategory,
        jobTitle: c.jobTitle,
        currentLocation: c.currentLocation,
        mobileLast4: c.mobileLast4,
        isNtSource: c.isNtSource,
        source: c.source,
        contactAttemptCount: c.contactAttemptCount,
        nextFollowupAt: c.nextFollowupAt,
        hasEmail: !!c.emailEnc,
        owner: c.owner,
        tasks: c.tasks,
        lastAttempt: c.contactAttempts[0] ?? null,
        due: due === null ? null : new Date(due),
        firstCall: firstCallFor.has(c.id),
      };
    }),
  };
}

/** Reveal a lead's number for dialling from a phone (logged as a PII view). */
export async function getLeadForCall(actor: UserActor, id: string): Promise<LeadCallView> {
  const lead = await prisma.candidate.findUnique({ where: { id } });
  if (!lead) throw notFound("Lead not found");
  const hasTask = (await prisma.task.count({ where: { candidateId: id, assigneeId: actor.id, status: "OPEN" } })) > 0;
  if (!canEditLead(actor, lead) && !hasTask && !canReadAll(actor)) throw new ForbiddenError("You can only call leads you own or have a task for.");

  await logPiiView(actor, id);
  const c = decryptCandidate(lead);
  return { id: c.id, name: c.name, candidateCode: c.candidateCode, stage: c.stage, isCold: c.isCold, mobile: c.mobile, altMobile: c.altMobile, email: c.email };
}

// ───────────── Missed-call inbox ─────────────

const MISSED_PAGE_SIZE = 30;
export const MISSED_CALL_ROLES = ["telecaller", "team1_leader", "admin"] as const;

export async function getMissedCallInbox(actor: UserActor, opts: { tab?: "open" | "closed"; page?: number }): Promise<MissedCallInbox> {
  if (!hasRole(actor, ...MISSED_CALL_ROLES)) throw new ForbiddenError("The missed-call inbox is for Team 1b.");
  const isLeader = hasRole(actor, "team1_leader", "admin");
  const tab = opts.tab === "closed" ? "closed" : "open";
  const page = Math.max(1, opts.page ?? 1);
  const t = now();

  const mine: Prisma.MissedCallWhereInput = isLeader ? {} : { assignedToId: actor.id };
  const where: Prisma.MissedCallWhereInput = { ...mine, closedAt: tab === "closed" ? { not: null } : null };
  const week: Prisma.MissedCallWhereInput = { ...mine, receivedAt: { gte: startOfIstWeek(t) } };

  const [calls, total, openCount, missed, recalled, answered, linkSent, enrolled] = await Promise.all([
    prisma.missedCall.findMany({ where, orderBy: { receivedAt: tab === "open" ? "asc" : "desc" }, skip: (page - 1) * MISSED_PAGE_SIZE, take: MISSED_PAGE_SIZE }),
    prisma.missedCall.count({ where }),
    prisma.missedCall.count({ where: { ...mine, closedAt: null } }),
    prisma.missedCall.count({ where: week }),
    prisma.missedCall.count({ where: { ...week, recallAttemptedAt: { not: null } } }),
    prisma.missedCall.count({ where: { ...week, answered: true } }),
    prisma.missedCall.count({ where: { ...week, linkSent: true } }),
    prisma.missedCall.count({ where: { ...week, enrolled: true } }),
  ]);

  // MissedCall has no Prisma relations; look up leads, assignees and recall tasks by id.
  const leadIds = [...new Set(calls.map((c) => c.candidateId).filter((x): x is string => !!x))];
  const userIds = [...new Set(calls.map((c) => c.assignedToId).filter((x): x is string => !!x))];
  const [leads, users, tasks] = await Promise.all([
    prisma.candidate.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true, candidateCode: true, stage: true, isCold: true } }),
    isLeader ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    prisma.task.findMany({ where: { refType: "missed_call", refId: { in: calls.map((c) => c.id) }, status: "OPEN" }, orderBy: { dueAt: "asc" }, select: { refId: true, dueAt: true } }),
  ]);
  const leadBy = new Map(leads.map((l) => [l.id, l]));
  const userBy = new Map(users.map((u) => [u.id, u.name]));
  const recallDue = new Map<string, Date>();
  for (const task of tasks) if (task.refId && !recallDue.has(task.refId)) recallDue.set(task.refId, task.dueAt);

  return {
    isLeader,
    tab,
    page,
    pageSize: MISSED_PAGE_SIZE,
    total,
    openCount,
    funnel: { missed, recalled, answered, linkSent, enrolled },
    calls: calls.map(({ fromMobileEnc: _enc, fromMobileHash: _hash, ...mc }) => ({
      ...mc,
      lead: (mc.candidateId && leadBy.get(mc.candidateId)) || null,
      assigneeName: (mc.assignedToId && userBy.get(mc.assignedToId)) || null,
      recallDue: recallDue.get(mc.id) ?? null,
    })),
  };
}

/** Reveal a missed caller's number for dialling (logged as a PII view). */
export async function getMissedCallForRecall(actor: UserActor, id: string): Promise<MissedCallView> {
  const mc = await prisma.missedCall.findUnique({ where: { id } });
  if (!mc) throw notFound("Missed call not found");
  const allowed = hasRole(actor, "team1_leader", "admin") || (hasRole(actor, "telecaller") && (mc.assignedToId === actor.id || mc.assignedToId === null));
  if (!allowed) throw new ForbiddenError("This missed call is assigned to another tele-caller.");

  if (mc.candidateId) await logPiiView(actor, mc.candidateId);
  else await audit(actor, "VIEW_PII", "missed_call", mc.id);
  const mobile = decrypt(mc.fromMobileEnc) ?? "";
  const lead = mc.candidateId ? await prisma.candidate.findUnique({ where: { id: mc.candidateId }, select: { id: true, name: true, candidateCode: true } }) : null;
  return { id: mc.id, receivedAt: mc.receivedAt, mobile, lead };
}
