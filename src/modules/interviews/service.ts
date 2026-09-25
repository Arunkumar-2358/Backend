import type { InterviewMode } from "@prisma/client";
import { prisma, withTx, type Tx } from "@/lib/db";
import { now, DAY, HOUR } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { getAllSettings } from "@/lib/settings";
import { formatDateTime } from "@contracts/shared/dates";
import { ValidationError } from "@/lib/errors";
import { type Actor, ForbiddenError, hasRole } from "@/lib/rbac";
import { transitionLead } from "@/modules/lifecycle/transition";
import { cancelJobs, scheduleJob } from "@/modules/jobs/queue";
import { closeTasks, ensureOpenTask } from "@/modules/tasks/service";
import { sendTemplate } from "@/modules/messaging/service";

function assertTeam3(actor: Actor) {
  if (!hasRole(actor, "admin", "recruiter", "team3_leader")) throw new ForbiddenError("Only Team 3 manages interviews, offers and joinings");
}

/**
 * Fix and communicate the interview; schedule T-24h / T-2h reminders.
 */
export async function scheduleInterview(actor: Actor, submissionId: string, input: { scheduledAt: Date; mode?: InterviewMode; notes?: string; communicate?: boolean }, db: Tx = prisma) {
  assertTeam3(actor);
  return withTx(db, async (tx) => {
    const sub = await tx.submission.findUniqueOrThrow({ where: { id: submissionId }, include: { candidate: true, vacancy: { include: { clientOrg: true } } } });
    if (sub.candidate.stage !== "SOURCED") throw new ValidationError("Interviews can only be scheduled for Sourced leads");
    if (input.scheduledAt.getTime() <= now().getTime()) throw new ValidationError("Interview time must be in the future");
    const communicate = input.communicate ?? true;
    const iv = await tx.interview.create({
      data: { submissionId, scheduledAt: input.scheduledAt, mode: input.mode ?? "IN_PERSON", notes: input.notes, communicatedAt: communicate ? now() : null },
    });
    if (communicate) {
      await sendTemplate(actor, sub.candidateId, "interview_scheduled", "WHATSAPP", { interviewAt: formatDateTime(input.scheduledAt), org: sub.vacancy.clientOrg.name, role: sub.vacancy.title }, tx);
    }
    await scheduleReminders(iv.id, input.scheduledAt, tx);
    await audit(actor, "CREATE", "interview", iv.id, { submissionId, scheduledAt: input.scheduledAt }, tx);
    return iv;
  });
}

async function scheduleReminders(interviewId: string, at: Date, tx: Tx) {
  const s = await getAllSettings(tx);
  for (const h of s.interviewReminderOffsetsHours) {
    const runAt = new Date(at.getTime() - h * HOUR);
    if (runAt.getTime() > now().getTime()) await scheduleJob("interview_reminder", runAt, { interviewId, hoursBefore: h }, `iv:${interviewId}:${h}`, tx);
  }
}

export async function markCommunicated(actor: Actor, interviewId: string, db: Tx = prisma) {
  assertTeam3(actor);
  const iv = await db.interview.update({ where: { id: interviewId }, data: { communicatedAt: now() } });
  await audit(actor, "FIELD_EDIT", "interview", interviewId, { communicatedAt: iv.communicatedAt }, db);
  return iv;
}

export async function rescheduleInterview(actor: Actor, interviewId: string, scheduledAt: Date, db: Tx = prisma) {
  assertTeam3(actor);
  return withTx(db, async (tx) => {
    await cancelJobs({ dedupePrefix: `iv:${interviewId}:` }, tx);
    const iv = await tx.interview.update({ where: { id: interviewId }, data: { scheduledAt, status: "SCHEDULED", communicatedAt: now() } });
    await scheduleReminders(interviewId, scheduledAt, tx);
    await audit(actor, "FIELD_EDIT", "interview", interviewId, { scheduledAt }, tx);
    return iv;
  });
}

/**
 * Record the interview outcome. Attended + selected → Selected (the scorecard
 * can inform this). No-show / rejected → Dropped with a reason code when the
 * lead has no other live submissions.
 */
export async function recordInterviewOutcome(actor: Actor, interviewId: string, input: { status: "ATTENDED" | "NO_SHOW" | "CANCELLED"; result?: "SELECTED" | "REJECTED" | "PENDING"; notes?: string }, db: Tx = prisma) {
  assertTeam3(actor);
  return withTx(db, async (tx) => {
    const current = await tx.interview.findUniqueOrThrow({ where: { id: interviewId } });
    if (current.status !== "SCHEDULED") throw new ValidationError("An outcome has already been recorded for this interview");
    const iv = await tx.interview.update({
      where: { id: interviewId },
      data: { status: input.status, attended: input.status === "ATTENDED", result: input.status === "ATTENDED" ? input.result ?? "PENDING" : "PENDING", notes: input.notes },
      include: { submission: true },
    });
    await cancelJobs({ dedupePrefix: `iv:${interviewId}:` }, tx);
    await audit(actor, "FIELD_EDIT", "interview", interviewId, input, tx);
    const leadId = iv.submission.candidateId;
    const lead = await tx.candidate.findUniqueOrThrow({ where: { id: leadId } });
    if (lead.stage !== "SOURCED") return iv;

    if (input.status === "ATTENDED" && input.result === "SELECTED") {
      await tx.submission.update({ where: { id: iv.submissionId }, data: { decision: "SHORTLISTED", decidedAt: now() } });
      await transitionLead(actor, leadId, "SELECTED", { note: "Selected at interview" }, tx);
    } else if (input.status === "NO_SHOW" || input.result === "REJECTED") {
      if (input.result === "REJECTED") await tx.submission.update({ where: { id: iv.submissionId }, data: { decision: "REJECTED", decidedAt: now() } });
      const otherLive = await tx.submission.count({ where: { candidateId: leadId, id: { not: iv.submissionId }, decision: { not: "REJECTED" } } });
      if (!otherLive) {
        await transitionLead(actor, leadId, "DROPPED", { dropReason: input.status === "NO_SHOW" ? "INTERVIEW_NO_SHOW" : "REJECTED", note: input.notes }, tx);
      }
    }
    return iv;
  });
}

export async function sendOffer(actor: Actor, submissionId: string, input: { ctcLakhs?: number | null; joiningDate?: Date | null }, db: Tx = prisma) {
  assertTeam3(actor);
  return withTx(db, async (tx) => {
    const sub = await tx.submission.findUniqueOrThrow({ where: { id: submissionId }, include: { candidate: true, vacancy: true } });
    if (sub.candidate.stage !== "SELECTED") throw new ValidationError("Offers are sent to Selected leads");
    const openOffer = await tx.offer.findFirst({ where: { submissionId, declinedAt: null } });
    if (openOffer) throw new ValidationError("An offer has already been sent for this submission");
    const offer = await tx.offer.create({ data: { submissionId, sentAt: now(), ctcLakhs: input.ctcLakhs, joiningDate: input.joiningDate } });
    await sendTemplate(actor, sub.candidateId, "offer_sent", "EMAIL", { role: sub.vacancy.title }, tx).catch(() => sendTemplate(actor, sub.candidateId, "offer_sent_whatsapp", "WHATSAPP", { role: sub.vacancy.title }, tx));
    const s = await getAllSettings(tx);
    await ensureOpenTask(actor, { type: "OFFER_FOLLOW_UP", title: "Offer follow-up: confirm acceptance and joining date", candidateId: sub.candidateId, assigneeId: sub.vacancy.recruiterId, dueAt: new Date(now().getTime() + s.offerFollowupIntervalHours * HOUR), refType: "offer", refId: offer.id }, tx);
    await scheduleJob("offer_follow_up", new Date(now().getTime() + s.offerFollowupIntervalHours * HOUR), { offerId: offer.id }, `offer:${offer.id}`, tx);
    await audit(actor, "CREATE", "offer", offer.id, { submissionId }, tx);
    return offer;
  });
}

export async function confirmJoiningDate(actor: Actor, offerId: string, joiningDate: Date, db: Tx = prisma) {
  assertTeam3(actor);
  const offer = await db.offer.update({ where: { id: offerId }, data: { acceptedAt: now(), joiningDate } });
  await audit(actor, "FIELD_EDIT", "offer", offerId, { acceptedAt: offer.acceptedAt, joiningDate }, db);
  return offer;
}

export async function declineOffer(actor: Actor, offerId: string, note: string | undefined, db: Tx = prisma) {
  assertTeam3(actor);
  return withTx(db, async (tx) => {
    const offer = await tx.offer.update({ where: { id: offerId }, data: { declinedAt: now() }, include: { submission: true } });
    await cancelJobs({ dedupePrefix: `offer:${offerId}` }, tx);
    await transitionLead(actor, offer.submission.candidateId, "DROPPED", { dropReason: "OFFER_DECLINED", note }, tx);
    return offer;
  });
}

/** Candidate joined → Joined; schedules the day-7 and day-30 retention checkpoints. */
export async function recordJoining(actor: Actor, offerId: string, joinedAt: Date, db: Tx = prisma) {
  assertTeam3(actor);
  return withTx(db, async (tx) => {
    const offer = await tx.offer.findUniqueOrThrow({ where: { id: offerId }, include: { submission: true } });
    if (!offer.joiningDate) await tx.offer.update({ where: { id: offerId }, data: { joiningDate: joinedAt, acceptedAt: offer.acceptedAt ?? now() } });
    const j = await tx.joining.create({ data: { offerId, joinedAt } });
    await cancelJobs({ dedupePrefix: `offer:${offerId}` }, tx);
    await closeTasks({ candidateId: offer.submission.candidateId, type: "OFFER_FOLLOW_UP" }, "Joined", tx);
    await transitionLead(actor, offer.submission.candidateId, "JOINED", { note: "Candidate joined" }, tx);
    const s = await getAllSettings(tx);
    for (const d of s.retentionDays) {
      await scheduleJob("retention_check", new Date(joinedAt.getTime() + d * DAY), { joiningId: j.id, day: d, candidateId: offer.submission.candidateId }, `ret:${j.id}:${d}`, tx);
    }
    await audit(actor, "CREATE", "joining", j.id, { joinedAt }, tx);
    return j;
  });
}

export async function completeFormalities(actor: Actor, joiningId: string, db: Tx = prisma) {
  assertTeam3(actor);
  const j = await db.joining.update({ where: { id: joiningId }, data: { formalitiesCompletedAt: now() } });
  await audit(actor, "FIELD_EDIT", "joining", joiningId, { formalitiesCompletedAt: j.formalitiesCompletedAt }, db);
  return j;
}

/**
 * Retention checkpoint. Day 7 retained → recorded. Day 30 retained → Successful
 * (closes a vacancy opening). Left → Dropped (LEFT_BEFORE_30_DAYS).
 */
export async function recordRetentionCheck(actor: Actor, joiningId: string, day: 7 | 30, retained: boolean, reason: string | undefined, db: Tx = prisma) {
  assertTeam3(actor);
  return withTx(db, async (tx) => {
    const j = await tx.joining.findUniqueOrThrow({ where: { id: joiningId }, include: { offer: { include: { submission: true } } } });
    const leadId = j.offer.submission.candidateId;
    const due = new Date(j.joinedAt.getTime() + day * DAY);
    if (now().getTime() < due.getTime() - DAY / 2) throw new ValidationError(`Day-${day} check is due on ${formatDateTime(due)}`);
    await closeTasks({ candidateId: leadId, type: "RETENTION_CHECK", refType: `joining_d${day}` }, retained ? "Retained" : "Left", tx);
    if (!retained) {
      await tx.joining.update({ where: { id: joiningId }, data: { leftAt: now(), reason } });
      await cancelJobs({ dedupePrefix: `ret:${joiningId}:` }, tx);
      await transitionLead(actor, leadId, "DROPPED", { dropReason: "LEFT_BEFORE_30_DAYS", note: reason }, tx);
      return tx.joining.findUniqueOrThrow({ where: { id: joiningId } });
    }
    if (day === 7) {
      await tx.joining.update({ where: { id: joiningId }, data: { retained7dAt: now() } });
    } else {
      if (!j.retained7dAt) throw new ValidationError("Record the day-7 check first");
      await tx.joining.update({ where: { id: joiningId }, data: { retained30dAt: now() } });
      if (!j.formalitiesCompletedAt) await tx.joining.update({ where: { id: joiningId }, data: { formalitiesCompletedAt: now() } });
      await transitionLead(actor, leadId, "SUCCESSFUL", { note: "Retained 30 days" }, tx);
    }
    await audit(actor, "FIELD_EDIT", "joining", joiningId, { day, retained }, tx);
    return tx.joining.findUniqueOrThrow({ where: { id: joiningId } });
  });
}
