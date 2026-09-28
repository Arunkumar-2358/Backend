import type { Stage, TeamCode } from "@prisma/client";
import { prisma, withTx, type Tx } from "@/lib/db";
import { now } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { getAllSettings } from "@/lib/settings";
import { GateError } from "@/lib/errors";
import { type Actor, ForbiddenError, actorId, isAdmin, isStageLeader, isStageTeamMember } from "@/lib/rbac";
import { pickAssignee } from "@/modules/users/assignment";
import { cancelOpenTasksForLead, ensureOpenTask } from "@/modules/tasks/service";
import { cancelJobs } from "@/modules/jobs/queue";
import { recomputeCompleteness } from "@/modules/candidates/service";
import { notify, isBulkActor, usersWithRole } from "@/modules/notifications/service";
import { EXIT_STAGES, STAGE_LABEL, allowedTargets, ruleFor, type TransitionPayload } from "./rules";

export type TransitionResult = { from: Stage; to: Stage; historyId: string };

/**
 * The ONLY way a lead changes stage (PLAN §3). Checks the transition is legal
 * (no skipping), the actor may perform it, and the gate passes; then writes
 * lead_stage_history + audit_log and fires side-effects (tasks, reminders,
 * routing) in the same transaction.
 */
export async function transitionLead(
  actor: Actor,
  leadId: string,
  toStage: Stage,
  payload: TransitionPayload = {},
  db: Tx = prisma,
): Promise<TransitionResult> {
  return withTx(db, async (tx) => {
    const lead = await tx.candidate.findUniqueOrThrow({ where: { id: leadId } });
    const from = lead.stage;
    if (from === toStage) throw new GateError([`Lead is already ${STAGE_LABEL[toStage]}`]);

    const rule = ruleFor(from, toStage);
    if (!rule) {
      const allowed = allowedTargets(from).map((s) => STAGE_LABEL[s]).join(", ") || "none (terminal stage)";
      throw new GateError([`Cannot move from ${STAGE_LABEL[from]} to ${STAGE_LABEL[toStage]}. Allowed: ${allowed}`]);
    }

    // Permission: owning team of the *current* stage; leader-only gates need a leader sign-off.
    if (actor.kind === "user" && !isAdmin(actor)) {
      if (rule.performer === "stage_leader") {
        if (!isStageLeader(actor, from)) throw new ForbiddenError(`Only the ${STAGE_LABEL[from]} team leader can sign off this gate`);
      } else {
        const hasTask = (await tx.task.count({ where: { candidateId: leadId, assigneeId: actor.id, status: "OPEN" } })) > 0;
        const ok = isStageTeamMember(actor, from) && (lead.ownerUserId === actor.id || isStageLeader(actor, from) || hasTask);
        if (!ok) throw new ForbiddenError(`You must own this lead or lead the ${STAGE_LABEL[from]} team to move it`);
      }
    }

    const settings = await getAllSettings(tx);
    const failures = await rule.gate({ db: tx, lead, payload, settings });
    if (failures.length) throw new GateError(failures);

    const at = now();
    await tx.candidate.update({
      where: { id: leadId },
      data: {
        stage: toStage,
        stageChangedAt: at,
        ...(toStage === "DROPPED" ? { dropReason: payload.dropReason } : {}),
      },
    });

    await sideEffects(actor, leadId, toStage, payload, tx);

    const after = await tx.candidate.findUniqueOrThrow({ where: { id: leadId } });
    const history = await tx.leadStageHistory.create({
      data: {
        candidateId: leadId,
        fromStage: from,
        toStage,
        byUserId: actorId(actor),
        bySystem: actor.kind === "system" ? actor.label : payload.source ?? null,
        at,
        note: payload.note ?? payload.tlRemark ?? (payload.dropReason ? `Drop reason: ${payload.dropReason}` : null),
        prevOwnerUserId: lead.ownerUserId,
        ownerUserId: after.ownerUserId,
      },
    });
    await audit(actor, "STAGE_CHANGE", "candidate", leadId, { from, to: toStage, note: payload.note, dropReason: payload.dropReason, ownerFrom: lead.ownerUserId, ownerTo: after.ownerUserId }, tx);
    return { from, to: toStage, historyId: history.id };
  });
}

async function routeTo(team: TeamCode, leadId: string, tx: Tx) {
  const lead = await tx.candidate.findUniqueOrThrow({ where: { id: leadId } });
  const owner = await pickAssignee(team, lead.mainCategory, tx);
  if (owner && owner !== lead.ownerUserId) await tx.candidate.update({ where: { id: leadId }, data: { ownerUserId: owner } });
  return owner ?? lead.ownerUserId;
}

async function sideEffects(actor: Actor, leadId: string, to: Stage, payload: TransitionPayload, tx: Tx) {
  const at = now();

  if (EXIT_STAGES.includes(to)) {
    await cancelOpenTasksForLead(leadId, `Lead moved to ${STAGE_LABEL[to]}`, tx);
    await cancelJobs({ candidateId: leadId }, tx);
    return;
  }

  switch (to) {
    case "VALIDATED": {
      // Validated leads go to the Team 1a TA lead for the category (configurable rules).
      const lead = await tx.candidate.findUniqueOrThrow({ where: { id: leadId } });
      const inT1 = lead.ownerUserId
        ? await tx.userTeamRole.count({ where: { userId: lead.ownerUserId, team: { code: { in: ["T1A", "T1B"] } } } })
        : 0;
      const owner = inT1 ? lead.ownerUserId : await routeTo("T1A", leadId, tx);
      await ensureOpenTask(actor, { type: "FOLLOW_UP", title: "First contact: send enrolment link", candidateId: leadId, assigneeId: owner, dueAt: at }, tx);
      await tx.candidate.update({ where: { id: leadId }, data: { nextFollowupAt: at } });
      break;
    }
    case "ENROLLED": {
      await cancelOpenTasksForLead(leadId, "Enrolled", tx, ["FOLLOW_UP", "RECALL"]);
      // Registering on the NT platform is the lead's first engagement signal.
      const prev = await tx.candidate.findUniqueOrThrow({ where: { id: leadId }, select: { lastEngagedAt: true } });
      await tx.candidate.update({ where: { id: leadId }, data: { enrolledAt: at, nextFollowupAt: null, lastEngagedAt: prev.lastEngagedAt && prev.lastEngagedAt > at ? prev.lastEngagedAt : at } });
      // Missed-call funnel: a recalled caller who registers counts as enrolled.
      await tx.missedCall.updateMany({ where: { candidateId: leadId, recallAttemptedAt: { not: null } }, data: { enrolled: true, closedAt: at } });
      const owner = await routeTo("T2", leadId, tx);
      const pct = await recomputeCompleteness(leadId, tx);
      if (pct < 100) {
        await ensureOpenTask(actor, { type: "COLLECT_DETAILS", title: `Call to collect missing profile details (${pct}% complete)`, candidateId: leadId, assigneeId: owner, dueAt: at, notify: false }, tx);
      }
      if (!isBulkActor(actor)) {
        const l = await tx.candidate.findUniqueOrThrow({ where: { id: leadId }, select: { name: true, candidateCode: true } });
        await notify(owner, { kind: "LEAD_ASSIGNED", title: `New enrolled lead: ${l.name}`, body: `${l.candidateCode} · profile ${pct}% complete${pct < 100 ? " — collect missing details" : " — ready for scrutiny"}`, link: `/leads/${leadId}` }, tx, actor);
      }
      break;
    }
    case "QUALIFIED": {
      const lead = await tx.candidate.findUniqueOrThrow({ where: { id: leadId } });
      await tx.candidate.update({
        where: { id: leadId },
        data: {
          verificationStatus: "COMPLETE_VERIFIED",
          verifiedById: actorId(actor),
          verifiedAt: at,
          tlRemarks: payload.tlRemark ?? lead.tlRemarks,
          scrutinizedAt: lead.scrutinizedAt ?? at,
          scrutinizedById: lead.scrutinizedById ?? actorId(actor),
          // Waits in the Team 3 leader's pool; allocation to a Team 2 sourcer starts the check-ins.
          allocatedAt: null,
          allocatedById: null,
        },
      });
      if (!isBulkActor(actor)) {
        await notify(await usersWithRole(["team3_leader"], undefined, tx), { kind: "LEAD_ASSIGNED", title: `Qualified lead to allocate: ${lead.name}`, body: `${lead.candidateCode}${lead.mainCategory ? ` · ${lead.mainCategory.toLowerCase()}` : ""} — assign it to a Team 2 sourcer`, link: "/allocation" }, tx, actor);
      }
      break;
    }
    case "ACTIVE": {
      await tx.candidate.update({ where: { id: leadId }, data: { isCold: false, coldSince: null } });
      await cancelOpenTasksForLead(leadId, "Availability confirmed", tx, ["AVAILABILITY_CHECK"]);
      await cancelJobs({ type: "availability_check", candidateId: leadId }, tx);
      break;
    }
    case "SUCCESSFUL": {
      // Terminal success: counts as a vacancy closure.
      const j = await tx.joining.findFirst({
        where: { offer: { submission: { candidateId: leadId } } },
        include: { offer: { include: { submission: true } } },
        orderBy: { joinedAt: "desc" },
      });
      if (j) {
        const v = await tx.vacancy.update({ where: { id: j.offer.submission.vacancyId }, data: { openingsFilled: { increment: 1 } } });
        if (v.openingsFilled >= v.openings && v.status !== "CLOSED") {
          await tx.vacancy.update({ where: { id: v.id }, data: { status: "CLOSED", closedAt: at } });
          await audit(actor, "FIELD_EDIT", "vacancy", v.id, { status: { from: v.status, to: "CLOSED" }, reason: "All openings filled" }, tx);
        }
      }
      await cancelOpenTasksForLead(leadId, "Successful", tx);
      break;
    }
    default:
      break;
  }
}
