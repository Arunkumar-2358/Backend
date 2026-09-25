import type { Channel, ContactDirection, ContactOutcome, MainCategory } from "@prisma/client";
import { prisma, withTx, type Tx } from "@/lib/db";
import { now, HOUR } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { getAllSettings } from "@/lib/settings";
import { encrypt } from "@/lib/crypto";
import { validateMobile } from "@contracts/shared/phone";
import { ValidationError } from "@/lib/errors";
import { type Actor, ForbiddenError, actorId, canEditLead, hasRole, SYSTEM } from "@/lib/rbac";
import { transitionLead } from "@/modules/lifecycle/transition";
import { closeTasks, createTask } from "@/modules/tasks/service";
import { createCandidate, findByEmail, findByMobile, mobileHashOf } from "@/modules/candidates/service";
import { sendTemplate } from "@/modules/messaging/service";
import { teamMembers } from "@/modules/users/assignment";

export { OUTCOME_LABEL } from "@contracts/shared/labels";
import { OUTCOME_LABEL } from "@contracts/shared/labels";

export type LogContactInput = {
  channel: Channel;
  direction?: ContactDirection;
  outcome: ContactOutcome;
  notes?: string;
  nextFollowupAt?: Date | null;
  linkSent?: boolean;
  isFirstTimeVerifiedCall?: boolean;
};

/**
 * Log a contact attempt (M2). In VALIDATED stage the outcome drives the life cycle:
 * ENROLLED → Enrolled; NOT_INTERESTED → exit; UNANSWERED / Bb / Bc → follow-up
 * task, until the attempt cap is hit, then → Unreachable.
 */
export async function logContact(actor: Actor, candidateId: string, input: LogContactInput, db: Tx = prisma) {
  return withTx(db, async (tx) => {
    const lead = await tx.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    if (actor.kind === "user") {
      const hasTask = (await tx.task.count({ where: { candidateId, assigneeId: actor.id, status: "OPEN" } })) > 0;
      if (!canEditLead(actor, lead) && !hasTask) throw new ForbiddenError("You can only log contact on leads you own or are working");
    }
    const settings = await getAllSettings(tx);
    const at = now();
    const linkSent = input.linkSent ?? input.outcome === "INTERESTED_LINK_SENT_NOT_REGISTERED";
    const followHours = settings.followupHours[input.outcome];
    const nextFollowupAt = input.nextFollowupAt ?? (followHours ? new Date(at.getTime() + followHours * HOUR) : null);

    const attempt = await tx.contactAttempt.create({
      data: {
        candidateId,
        channel: input.channel,
        direction: input.direction ?? "OUTBOUND",
        outcome: input.outcome,
        notes: input.notes,
        linkSent,
        isFirstTimeVerifiedCall: input.isFirstTimeVerifiedCall ?? false,
        nextFollowupAt,
        byUserId: actorId(actor),
        at,
      },
    });
    const attempts = lead.contactAttemptCount + (input.direction === "INBOUND_MISSED" ? 0 : 1);
    await tx.candidate.update({ where: { id: candidateId }, data: { contactAttemptCount: attempts, nextFollowupAt } });
    await audit(actor, "CONTACT_LOGGED", "candidate", candidateId, { attemptId: attempt.id, channel: input.channel, outcome: input.outcome }, tx);

    let transitioned: string | null = null;
    if (lead.stage === "VALIDATED") {
      if (input.outcome === "ENROLLED") {
        await transitionLead(actor, candidateId, "ENROLLED", { note: "Enrolled via outreach" }, tx);
        transitioned = "ENROLLED";
      } else if (input.outcome === "NOT_INTERESTED") {
        await transitionLead(actor, candidateId, "NOT_INTERESTED", { note: input.notes || "Not interested (contact outcome)" }, tx);
        transitioned = "NOT_INTERESTED";
      } else if (attempts >= settings.maxContactAttempts) {
        await transitionLead(SYSTEM("attempt-cap"), candidateId, "UNREACHABLE", { note: `${attempts} attempts without enrolment` }, tx);
        transitioned = "UNREACHABLE";
      } else {
        // This attempt resolves the outstanding follow-up / recall work; schedule the next one.
        await closeTasks({ candidateId, type: { in: ["FOLLOW_UP", "RECALL"] }, OR: [{ refType: null }, { refType: { not: "missed_call" } }] }, `Contact logged: ${OUTCOME_LABEL[input.outcome]}`, tx);
        const type = input.outcome === "BUSY_RECALL_REQUESTED" ? "RECALL" : "FOLLOW_UP";
        const title =
          input.outcome === "BUSY_RECALL_REQUESTED"
            ? "Recall (candidate asked to call back)"
            : input.outcome === "INTERESTED_LINK_SENT_NOT_REGISTERED"
              ? "Follow up: link sent, not yet registered"
              : `Follow up: attempt ${attempts + 1} of ${settings.maxContactAttempts}`;
        await createTask(SYSTEM("follow-up-engine"), {
          type,
          title,
          candidateId,
          assigneeId: actorId(actor) ?? lead.ownerUserId,
          dueAt: nextFollowupAt ?? new Date(at.getTime() + 24 * HOUR),
        }, tx);
      }
    }
    if (transitioned === null && lead.stage !== "VALIDATED") {
      await closeTasks({ candidateId, type: { in: ["FOLLOW_UP", "RECALL"] }, OR: [{ refType: null }, { refType: { not: "missed_call" } }] }, `Contact logged: ${OUTCOME_LABEL[input.outcome]}`, tx);
    }
    return { attempt, transitioned };
  });
}

/** Send the enrolment link from a template and log it as a Bb attempt. */
export async function sendEnrolmentLink(actor: Actor, candidateId: string, channel: Exclude<Channel, "CALL" | "NT_PLATFORM">, db: Tx = prisma) {
  return withTx(db, async (tx) => {
    const key = channel === "WHATSAPP" ? "enrolment_link_whatsapp" : channel === "SMS" ? "enrolment_link_sms" : "enrolment_link_email";
    await sendTemplate(actor, candidateId, key, channel, {}, tx);
    return logContact(actor, candidateId, { channel, outcome: "INTERESTED_LINK_SENT_NOT_REGISTERED", linkSent: true, notes: "Enrolment link sent from template" }, tx);
  });
}

/** Team 1 leader allocates validated leads to a tele-caller for first-time verified calls. */
export async function allocateToTelecaller(actor: Actor, candidateIds: string[], telecallerId: string, db: Tx = prisma) {
  if (!hasRole(actor, "team1_leader", "admin")) throw new ForbiddenError("Only the Team 1 leader can allocate calls");
  const isCaller = await db.userTeamRole.count({ where: { userId: telecallerId, role: "telecaller", team: { code: "T1B" }, user: { active: true } } });
  if (!isCaller) throw new ValidationError("Calls can only be allocated to an active Team 1b tele-caller");
  let n = 0;
  for (const id of candidateIds) {
    const lead = await db.candidate.findUniqueOrThrow({ where: { id } });
    if (lead.stage !== "VALIDATED") continue;
    const already = await db.task.count({ where: { candidateId: id, refType: "first_call", status: "OPEN" } });
    if (already) continue;
    await createTask(actor, { type: "FOLLOW_UP", title: "First-time verified call", candidateId: id, assigneeId: telecallerId, dueAt: now(), refType: "first_call" }, db);
    n++;
  }
  return n;
}

// ───────────── Missed-call inbox (Team 1b) ─────────────

export async function logMissedCall(actor: Actor, input: { mobile: string; receivedAt?: Date; notes?: string }, db: Tx = prisma) {
  const m = validateMobile(input.mobile);
  if (!m.ok) throw new ValidationError(m.reason);
  // Telephony retries: a repeat call from the same number within 2 hours joins the open entry.
  const recent = await db.missedCall.findFirst({
    where: { fromMobileHash: mobileHashOf(m.mobile), closedAt: null, receivedAt: { gte: new Date(now().getTime() - 2 * HOUR) } },
  });
  if (recent) return recent;
  const lead = await findByMobile(m.mobile, db);
  let assignee = actor.kind === "user" && hasRole(actor, "telecaller") ? actor.id : null;
  if (!assignee) {
    // round-robin by fewest open missed calls
    const callers = (await teamMembers("T1B", db)).filter((u) => u.roles.some((r) => r.role === "telecaller"));
    if (callers.length) {
      const loads = await Promise.all(callers.map(async (u) => ({ id: u.id, n: await db.missedCall.count({ where: { assignedToId: u.id, closedAt: null } }) })));
      assignee = loads.sort((a, b) => a.n - b.n)[0].id;
    }
  }
  const mc = await db.missedCall.create({
    data: {
      fromMobileEnc: encrypt(m.mobile),
      fromMobileHash: mobileHashOf(m.mobile),
      fromLast4: m.mobile.slice(-4),
      receivedAt: input.receivedAt ?? now(),
      candidateId: lead?.id,
      assignedToId: assignee,
      notes: input.notes,
    },
  });
  await createTask(actor, { type: "RECALL", title: `Recall missed call ••••${m.mobile.slice(-4)}`, candidateId: lead?.id, assigneeId: assignee, dueAt: now(), refType: "missed_call", refId: mc.id }, db);
  if (lead) {
    await db.contactAttempt.create({ data: { candidateId: lead.id, channel: "CALL", direction: "INBOUND_MISSED", outcome: "UNANSWERED", notes: "Missed incoming call", byUserId: actorId(actor), at: input.receivedAt ?? now() } });
  }
  await audit(actor, "CREATE", "missed_call", mc.id, { candidateId: lead?.id }, db);
  return mc;
}

export type RecallInput = {
  answered: boolean;
  linkSent?: boolean;
  enrolled?: boolean;
  notes?: string;
  /** create a lead when the caller is unknown */
  newLead?: { name: string; mainCategory?: MainCategory; currentLocation?: string; jobTitle?: string };
};

export async function recordRecall(actor: Actor, missedCallId: string, input: RecallInput, db: Tx = prisma) {
  return withTx(db, async (tx) => {
    const mc = await tx.missedCall.findUniqueOrThrow({ where: { id: missedCallId } });
    let candidateId = mc.candidateId;
    if (!candidateId && input.newLead && input.answered) {
      const { decrypt } = await import("@/lib/crypto");
      const c = await createCandidate(actor, { name: input.newLead.name, mobile: decrypt(mc.fromMobileEnc)!, mainCategory: input.newLead.mainCategory, currentLocation: input.newLead.currentLocation, jobTitle: input.newLead.jobTitle, source: "OTHER" }, { ownerUserId: actorId(actor) }, tx);
      candidateId = c.id;
      try {
        await transitionLead(SYSTEM("missed-call"), c.id, "VALIDATED", { note: "Created from missed call" }, tx);
        await tx.candidate.update({ where: { id: c.id }, data: { ownerUserId: actorId(actor) } });
      } catch {
        /* stays in Mapping for the data analyst */
      }
    }
    const at = now();
    await tx.missedCall.update({
      where: { id: missedCallId },
      data: {
        candidateId,
        recallAttemptedAt: mc.recallAttemptedAt ?? at,
        answered: mc.answered || input.answered,
        linkSent: mc.linkSent || !!input.linkSent,
        enrolled: mc.enrolled || !!input.enrolled,
        notes: input.notes ?? mc.notes,
        closedAt: input.enrolled || (input.answered && !input.linkSent) ? at : mc.closedAt,
      },
    });
    if (candidateId) {
      const lead = await tx.candidate.findUniqueOrThrow({ where: { id: candidateId } });
      if (lead.stage === "VALIDATED") {
        const outcome: ContactOutcome = input.enrolled ? "ENROLLED" : !input.answered ? "UNANSWERED" : input.linkSent ? "INTERESTED_LINK_SENT_NOT_REGISTERED" : "ANSWERED";
        await logContact(actor, candidateId, { channel: "CALL", direction: "RECALL", outcome, notes: input.notes, linkSent: input.linkSent }, tx);
      }
    }
    // Close the recall task only after logging, so the tele-caller keeps permission to enrol the lead.
    await closeTasks({ refType: "missed_call", refId: missedCallId }, input.answered ? "Recalled — answered" : "Recalled — unanswered", tx);
    if (!input.answered) {
      await createTask(actor, { type: "RECALL", title: `Recall again ••••${mc.fromLast4}`, candidateId, assigneeId: mc.assignedToId, dueAt: new Date(at.getTime() + 2 * HOUR), refType: "missed_call", refId: missedCallId }, tx);
    }
    return tx.missedCall.findUniqueOrThrow({ where: { id: missedCallId } });
  });
}

// ───────────── NT platform enrolment webhook ─────────────

export type NtEnrolmentEvent = {
  mobile: string;
  email?: string;
  name?: string;
  ntUserId?: string;
  mainCategory?: MainCategory;
  currentLocation?: string;
  jobTitle?: string;
  registeredAt?: string;
};

/**
 * Called when a candidate registers on the NT platform. Marks the lead
 * Enrolled (logging an NT_PLATFORM attempt so the gate is satisfied).
 * Unknown candidates are created as NT-sourced leads.
 */
export async function handleNtEnrolment(evt: NtEnrolmentEvent, db: Tx = prisma) {
  const actor = SYSTEM("nt-webhook");
  return withTx(db, async (tx) => {
    const m = validateMobile(evt.mobile);
    if (!m.ok) throw new ValidationError(m.reason);
    let lead = (await findByMobile(m.mobile, tx)) ?? (evt.email ? await findByEmail(evt.email, tx) : null);
    let created = false;
    if (!lead) {
      lead = await createCandidate(actor, { name: evt.name || "NT registrant", mobile: m.mobile, email: evt.email, source: "NT", mainCategory: evt.mainCategory, currentLocation: evt.currentLocation, jobTitle: evt.jobTitle }, {}, tx);
      created = true;
    }
    if (lead.stage === "MAPPING") {
      try {
        await transitionLead(actor, lead.id, "VALIDATED", { note: "NT registration" }, tx);
      } catch {
        return { candidateId: lead.id, created, stage: "MAPPING", note: "Lead needs mapping (category / geography) before it can be enrolled" };
      }
    }
    lead = await tx.candidate.findUniqueOrThrow({ where: { id: lead.id } });
    if (lead.stage !== "VALIDATED") return { candidateId: lead.id, created, stage: lead.stage, note: "No change — lead is not in Validated" };
    await tx.contactAttempt.create({
      data: { candidateId: lead.id, channel: "NT_PLATFORM", direction: "OUTBOUND", outcome: "ENROLLED", notes: `Registered on NT platform${evt.ntUserId ? ` (${evt.ntUserId})` : ""}`, at: evt.registeredAt ? new Date(evt.registeredAt) : now() },
    });
    await transitionLead(actor, lead.id, "ENROLLED", { note: "NT platform registration webhook", source: "nt-webhook" }, tx);
    return { candidateId: lead.id, created, stage: "ENROLLED" };
  });
}
