/**
 * Cold-lead calls (Team 2). The Team 2 leader allocates cold leads (no platform visit for
 * longer than the warm window) to a Team 2 member, who calls to ask whether they need a
 * job: "needs a job" → super active; unanswered → a recall, up to coldCallMaxAttempts.
 * Runs alongside the automatic re-engagement WhatsApp.
 */
import type { MainCategory, Prisma } from "@prisma/client";
import { prisma, withTx, type Tx } from "@/lib/db";
import { now, HOUR } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { getAllSettings } from "@/lib/settings";
import { ValidationError } from "@/lib/errors";
import { type Actor, ForbiddenError, actorId, actorLabel, hasRole } from "@/lib/rbac";
import { ENGAGEMENT_STAGES } from "@contracts/shared/engagement";
import { closeTasks, createTask } from "@/modules/tasks/service";
import { notify } from "@/modules/notifications/service";
import { PENDING_ALLOCATION } from "@/modules/allocation/service";
import { applyJobIntent, tierDays } from "@/modules/engagement/service";
import { tierWhere } from "@/modules/engagement/queries";

export const COLD_CALL_OUTCOMES = ["UNANSWERED", "NOT_INTERESTED", "NEEDS_JOB"] as const;
export type ColdCallOutcome = (typeof COLD_CALL_OUTCOMES)[number];

export function canAllocateColdCalls(actor: Actor) {
  return hasRole(actor, "team2_leader", "admin");
}

/** Cold Qualified / Active leads not yet allocated for a call in their current cold spell. */
export async function coldPoolWhere(db: Tx = prisma): Promise<Prisma.CandidateWhereInput> {
  const days = tierDays(await getAllSettings(db));
  return {
    AND: [
      { stage: { in: ENGAGEMENT_STAGES }, anonymizedAt: null, NOT: PENDING_ALLOCATION },
      tierWhere("COLD", now(), days),
      // A later visit / job need starts a new cold spell, which can be allocated again.
      { OR: [{ coldCallAllocatedAt: null }, { coldCallAllocatedAt: { lt: prisma.candidate.fields.lastEngagedAt } }] },
    ],
  };
}

export type AllocateColdCallsInput = {
  callerId: string;
  /** Specific leads… */
  ids?: string[];
  /** …or the next `count` waiting leads of a category ("NONE" = no category set). */
  category?: MainCategory | "NONE";
  count?: number;
};

export async function allocateColdCalls(actor: Actor, input: AllocateColdCallsInput, db: Tx = prisma) {
  if (!canAllocateColdCalls(actor)) throw new ForbiddenError("Only the Team 2 leader allocates cold-lead calls");
  if (!input.ids?.length && !input.category) throw new ValidationError("Pick the leads or a category to allocate");
  return withTx(db, async (tx) => {
    const caller = await tx.user.findFirst({
      where: { id: input.callerId, active: true, roles: { some: { role: { in: ["sourcer", "team2_leader"] }, team: { code: "T2" } } } },
      select: { id: true, name: true },
    });
    if (!caller) throw new ValidationError("Pick an active Team 2 member to call");

    const where: Prisma.CandidateWhereInput = {
      AND: [
        await coldPoolWhere(tx),
        input.ids?.length ? { id: { in: input.ids } } : {},
        input.category ? { mainCategory: input.category === "NONE" ? null : input.category } : {},
      ],
    };
    const take = input.ids?.length ? undefined : Math.min(500, Math.max(1, Math.round(input.count ?? 500)));
    // Most recently engaged first: they are the likeliest to pick up.
    const leads = await tx.candidate.findMany({ where, select: { id: true }, orderBy: [{ lastEngagedAt: { sort: "desc", nulls: "last" } }, { candidateCode: "asc" }], take });
    if (!leads.length) throw new ValidationError("No cold leads are waiting for a call there");

    const at = now();
    for (const lead of leads) {
      await createTask(actor, { type: "COLD_CALL", title: "Cold lead call: ask if they need a job", candidateId: lead.id, assigneeId: caller.id, dueAt: at, notify: false }, tx);
      await tx.candidate.update({ where: { id: lead.id }, data: { coldCallAllocatedAt: at } });
    }
    await notify(caller.id, {
      kind: "TASK",
      title: `${leads.length} cold lead${leads.length === 1 ? "" : "s"} to call`,
      body: `Allocated by ${actorLabel(actor)} — ask if they need a job`,
      link: "/cold-calls",
    }, tx, actor);
    return { count: leads.length, caller };
  });
}

/** The open cold-call task for a lead, if the actor may work it (its assignee, the Team 2 leader or admin). */
export async function openColdCallTask(actor: Actor, candidateId: string, db: Tx = prisma) {
  const task = await db.task.findFirst({ where: { candidateId, type: "COLD_CALL", status: "OPEN" }, orderBy: { createdAt: "desc" } });
  if (!task) throw new ValidationError("No cold-lead call is allocated for this lead");
  if (actor.kind === "user" && task.assigneeId !== actor.id && !canAllocateColdCalls(actor)) throw new ForbiddenError("This call is allocated to someone else");
  return task;
}

/**
 * Log a cold-lead call. The first call on an allocation is an attempt; later ones are
 * re-attempts (direction RECALL) — the daily dashboard counts them separately.
 */
export async function logColdCall(actor: Actor, candidateId: string, input: { outcome: ColdCallOutcome; notes?: string }, db: Tx = prisma) {
  return withTx(db, async (tx) => {
    const task = await openColdCallTask(actor, candidateId, tx);
    const settings = await getAllSettings(tx);
    const at = now();
    const earlier = await tx.contactAttempt.count({ where: { candidateId, coldCall: true, at: { gte: task.createdAt } } });
    const attempt = await tx.contactAttempt.create({
      data: { candidateId, channel: "CALL", direction: earlier ? "RECALL" : "OUTBOUND", outcome: input.outcome, coldCall: true, notes: input.notes, byUserId: actorId(actor), at },
    });
    await audit(actor, "CONTACT_LOGGED", "candidate", candidateId, { attemptId: attempt.id, coldCall: true, outcome: input.outcome, recall: earlier > 0 }, tx);

    const attempts = earlier + 1;
    if (input.outcome === "NEEDS_JOB") {
      await applyJobIntent(actor, candidateId, input.notes ? `Cold-lead call: ${input.notes}` : "Cold-lead call", tx);
      await closeTasks({ id: task.id }, "Needs a job — super active", tx);
      return { outcome: input.outcome, closed: true, attempts };
    }
    if (input.outcome === "NOT_INTERESTED") {
      await closeTasks({ id: task.id }, "Answered — not looking", tx);
      return { outcome: input.outcome, closed: true, attempts };
    }
    if (attempts >= settings.coldCallMaxAttempts) {
      await closeTasks({ id: task.id }, `No answer after ${attempts} attempts`, tx);
      return { outcome: input.outcome, closed: true, attempts };
    }
    await tx.task.update({
      where: { id: task.id },
      data: { dueAt: new Date(at.getTime() + settings.coldCallRecallHours * HOUR), title: `Cold lead recall (attempt ${attempts + 1} of ${settings.coldCallMaxAttempts})` },
    });
    return { outcome: input.outcome, closed: false, attempts };
  });
}
