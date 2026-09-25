import { prisma, withTx, type Tx } from "@/lib/db";
import { now } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { getSetting } from "@/lib/settings";
import { ValidationError } from "@/lib/errors";
import { type Actor, ForbiddenError, actorId, isStageTeamMember } from "@/lib/rbac";
import { decryptCandidate, recomputeCompleteness } from "@/modules/candidates/service";
import { missingMandatory } from "@contracts/shared/fields";
import { ensureOpenTask, closeTasks } from "@/modules/tasks/service";
import { transitionLead } from "@/modules/lifecycle/transition";
import { scheduleJob } from "@/modules/jobs/queue";
import { DAY } from "@/lib/clock";

export async function profileChecklist(candidateId: string, db: Tx = prisma) {
  const c = decryptCandidate(await db.candidate.findUniqueOrThrow({ where: { id: candidateId } }));
  const mandatory = await getSetting("mandatorySopFields", db);
  const missing = missingMandatory(c, mandatory);
  return { mandatory, missing, pct: Math.round(((mandatory.length - missing.length) / Math.max(1, mandatory.length)) * 100) };
}

/**
 * Team 2 scrutiny of an enrolled lead (M3). Records that it was scrutinised;
 * if mandatory fields are missing, a "call to collect details" task is created.
 */
export async function scrutinize(actor: Actor, candidateId: string, remark?: string, db: Tx = prisma) {
  return withTx(db, async (tx) => {
    const lead = await tx.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    if (lead.stage !== "ENROLLED") throw new ValidationError("Only Enrolled leads are scrutinised");
    if (!isStageTeamMember(actor, "ENROLLED")) throw new ForbiddenError("Only Team 2 can scrutinise enrolled leads");
    await recomputeCompleteness(candidateId, tx);
    const check = await profileChecklist(candidateId, tx);
    await tx.candidate.update({
      where: { id: candidateId },
      data: { scrutinizedAt: lead.scrutinizedAt ?? now(), scrutinizedById: lead.scrutinizedById ?? actorId(actor), tlRemarks: remark ?? lead.tlRemarks },
    });
    if (check.missing.length) {
      await ensureOpenTask(actor, {
        type: "COLLECT_DETAILS",
        title: `Call to collect details: ${check.missing.length} field(s) missing`,
        candidateId,
        assigneeId: lead.ownerUserId,
        dueAt: now(),
      }, tx);
    }
    await audit(actor, "FIELD_EDIT", "candidate", candidateId, { scrutinized: true, missing: check.missing, remark }, tx);
    return check;
  });
}

/** Team 2 leader sign-off: "Status: complete and verified by team leader" → Qualified. */
export async function verifyAndQualify(actor: Actor, candidateId: string, tlRemark: string | undefined, db: Tx = prisma) {
  return withTx(db, async (tx) => {
    await recomputeCompleteness(candidateId, tx);
    return transitionLead(actor, candidateId, "QUALIFIED", { tlRemark }, tx);
  });
}

/**
 * Availability check-in (every 60 days while Qualified). Confirmed → Active
 * (a cold lead confirming counts as a cold → warm conversion); not confirmed →
 * flagged cold and stays Qualified.
 */
export async function recordAvailabilityCheck(actor: Actor, candidateId: string, available: boolean, notes: string | undefined, db: Tx = prisma) {
  return withTx(db, async (tx) => {
    const lead = await tx.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    if (!isStageTeamMember(actor, "QUALIFIED")) throw new ForbiddenError("Only Team 2 records availability check-ins");
    if (lead.stage !== "QUALIFIED" && lead.stage !== "ACTIVE") throw new ValidationError("Availability check-ins apply to Qualified or Active leads");
    const check = await tx.availabilityCheck.create({
      data: { candidateId, available, wasCold: lead.isCold, byUserId: actorId(actor), notes, checkedAt: now() },
    });
    await closeTasks({ candidateId, type: "AVAILABILITY_CHECK" }, available ? "Available" : "Not available", tx);
    if (available && lead.stage === "QUALIFIED") {
      await transitionLead(actor, candidateId, "ACTIVE", { note: lead.isCold ? "Cold → warm: availability confirmed" : "Availability confirmed" }, tx);
    } else if (!available) {
      await tx.candidate.update({ where: { id: candidateId }, data: { isCold: true, coldSince: lead.coldSince ?? now() } });
      const interval = await getSetting("availabilityCheckIntervalDays", tx);
      await scheduleJob("availability_check", new Date(now().getTime() + interval * DAY), { candidateId }, `avail:${candidateId}`, tx);
      await audit(actor, "FIELD_EDIT", "candidate", candidateId, { isCold: { from: lead.isCold, to: true } }, tx);
    }
    return check;
  });
}

export async function setCold(actor: Actor, candidateId: string, cold: boolean, db: Tx = prisma) {
  const lead = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
  if (!isStageTeamMember(actor, lead.stage)) throw new ForbiddenError();
  await db.candidate.update({ where: { id: candidateId }, data: { isCold: cold, coldSince: cold ? lead.coldSince ?? now() : null } });
  await audit(actor, "FIELD_EDIT", "candidate", candidateId, { isCold: { from: lead.isCold, to: cold } }, db);
}
