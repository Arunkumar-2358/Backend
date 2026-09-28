/**
 * Team 3 → Team 2 allocation. A lead that is enrolled and qualified first lands in
 * the Team 3 leader's pool; the leader hands it, by category (Doctor, Pharmacy, …),
 * to a Team 2 sourcer, who then owns it for availability check-ins and matching.
 */
import type { MainCategory, Prisma } from "@prisma/client";
import { prisma, withTx, type Tx } from "@/lib/db";
import { now, DAY } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { getAllSettings } from "@/lib/settings";
import { ValidationError } from "@/lib/errors";
import { type Actor, ForbiddenError, actorId, actorLabel, hasRole } from "@/lib/rbac";
import { ensureOpenTask } from "@/modules/tasks/service";
import { scheduleJob } from "@/modules/jobs/queue";
import { notify } from "@/modules/notifications/service";

/** Where the leads waiting for the Team 3 leader live. */
export const PENDING_ALLOCATION: Prisma.CandidateWhereInput = { stage: "QUALIFIED", allocatedAt: null, anonymizedAt: null };

export function canAllocate(actor: Actor) {
  return hasRole(actor, "team3_leader", "admin");
}

export type AllocateInput = {
  sourcerId: string;
  /** Specific leads… */
  ids?: string[];
  /** …or every pending lead of a category ("NONE" = no category set). */
  category?: MainCategory | "NONE";
};

export async function allocateQualified(actor: Actor, input: AllocateInput, db: Tx = prisma) {
  if (!canAllocate(actor)) throw new ForbiddenError("Only the Team 3 leader allocates qualified leads to Team 2");
  if (!input.ids?.length && !input.category) throw new ValidationError("Pick the leads or a category to allocate");
  return withTx(db, async (tx) => {
    const sourcer = await tx.user.findFirst({
      where: { id: input.sourcerId, active: true, roles: { some: { role: { in: ["sourcer", "team2_leader"] }, team: { code: "T2" } } } },
      select: { id: true, name: true },
    });
    if (!sourcer) throw new ValidationError("Pick an active Team 2 member");

    const where: Prisma.CandidateWhereInput = {
      ...PENDING_ALLOCATION,
      ...(input.ids?.length ? { id: { in: input.ids } } : {}),
      ...(input.category ? { mainCategory: input.category === "NONE" ? null : input.category } : {}),
    };
    const leads = await tx.candidate.findMany({ where, select: { id: true, ownerUserId: true, mainCategory: true }, orderBy: { stageChangedAt: "asc" } });
    if (!leads.length) throw new ValidationError("No qualified leads are waiting for allocation there");

    const at = now();
    const settings = await getAllSettings(tx);
    // Conditional claim: skip a lead a concurrent allocation already took (its allocatedAt is no longer null).
    const claimed: typeof leads = [];
    for (const lead of leads) {
      const { count } = await tx.candidate.updateMany({ where: { id: lead.id, ...PENDING_ALLOCATION }, data: { ownerUserId: sourcer.id, allocatedAt: at, allocatedById: actorId(actor) } });
      if (!count) continue;
      claimed.push(lead);
      // Team 2 starts here: the first availability check-in, then one every interval while Qualified.
      await ensureOpenTask(actor, { type: "AVAILABILITY_CHECK", title: "Availability check-in", candidateId: lead.id, assigneeId: sourcer.id, dueAt: at, notify: false }, tx);
      await scheduleJob("availability_check", new Date(at.getTime() + settings.availabilityCheckIntervalDays * DAY), { candidateId: lead.id }, `avail:${lead.id}`, tx);
      await audit(actor, "REASSIGN", "candidate", lead.id, { allocation: true, ownerFrom: lead.ownerUserId, ownerTo: sourcer.id }, tx);
    }
    if (!claimed.length) throw new ValidationError("Those leads were just allocated by someone else — refresh and try again");

    const cats = [...new Set(claimed.map((l) => l.mainCategory ?? "uncategorised"))].map((c) => c.toLowerCase()).join(", ");
    await notify(sourcer.id, {
      kind: "LEAD_ASSIGNED",
      title: `${claimed.length} qualified lead${claimed.length === 1 ? "" : "s"} allocated to you`,
      body: `${cats} · by ${actorLabel(actor)} — availability check-ins are due`,
      link: "/availability",
    }, tx, actor);
    return { count: claimed.length, sourcer };
  });
}
