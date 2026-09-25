import type { MainCategory, Vacancy } from "@prisma/client";
import { prisma, withTx, type Tx } from "@/lib/db";
import { now, MINUTE } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { getAllSettings } from "@/lib/settings";
import { istHour } from "@contracts/shared/dates";
import { ValidationError } from "@/lib/errors";
import { type Actor, ForbiddenError, actorId, hasRole } from "@/lib/rbac";
import { pickAssignee } from "@/modules/users/assignment";
import { transitionLead } from "@/modules/lifecycle/transition";
import { sendTemplate } from "@/modules/messaging/service";
import { rankMatches } from "./matching";
import { ROUTING } from "@contracts/shared/labels";
import { notify } from "@/modules/notifications/service";

/** Client org type routes the vacancy: general → 3a, existing clients → 3b, free-trial orgs → 3c. */
export { ROUTING } from "@contracts/shared/labels";

export type VacancyInput = {
  clientOrgId: string;
  title: string;
  category: MainCategory;
  specialty?: string | null;
  location: string;
  minExperienceYears?: number | null;
  ctcMinLakhs?: number | null;
  ctcMaxLakhs?: number | null;
  maxNoticeDays?: number | null;
  openings?: number;
  postedAt?: Date;
};

async function nextVacancyCode(db: Tx) {
  const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT nextval('vacancy_code_seq') AS n`;
  return `VAC${String(rows[0].n).padStart(5, "0")}`;
}

export async function createVacancy(actor: Actor, input: VacancyInput, db: Tx = prisma) {
  if (!hasRole(actor, "admin", "sourcer", "team2_leader", "recruiter", "team3_leader")) throw new ForbiddenError("Only Teams 2/3 can add vacancies");
  return withTx(db, async (tx) => {
    const org = await tx.clientOrg.findUniqueOrThrow({ where: { id: input.clientOrgId } });
    const routedTeam = ROUTING[org.type];
    const postedAt = input.postedAt ?? now();
    const recruiterId = await pickAssignee(routedTeam, input.category, tx);
    const sourcerId = await pickAssignee("T2", input.category, tx);
    const v = await tx.vacancy.create({
      data: {
        ...input,
        code: await nextVacancyCode(tx),
        postedAt,
        addedBefore2pm: istHour(postedAt) < 14,
        routedTeam,
        recruiterId,
        sourcerId,
        status: "OPEN",
        createdAt: now(),
      },
    });
    await audit(actor, "CREATE", "vacancy", v.id, { routedTeam, recruiterId, sourcerId, addedBefore2pm: v.addedBefore2pm }, tx);
    return v;
  });
}

export async function calibrateVacancy(actor: Actor, vacancyId: string, db: Tx = prisma) {
  if (!hasRole(actor, "admin", "sourcer", "team2_leader", "recruiter", "team3_leader")) throw new ForbiddenError();
  const v = await db.vacancy.findUniqueOrThrow({ where: { id: vacancyId } });
  if (v.calibratedAt) return v;
  const u = await db.vacancy.update({ where: { id: vacancyId }, data: { calibratedAt: now() } });
  await audit(actor, "FIELD_EDIT", "vacancy", vacancyId, { calibratedAt: u.calibratedAt }, db);
  return u;
}

export async function setVacancyStatus(actor: Actor, vacancyId: string, status: "OPEN" | "PENDING" | "CLOSED", db: Tx = prisma) {
  if (!hasRole(actor, "admin", "sourcer", "team2_leader", "recruiter", "team3_leader")) throw new ForbiddenError();
  const v = await db.vacancy.findUniqueOrThrow({ where: { id: vacancyId } });
  const u = await db.vacancy.update({
    where: { id: vacancyId },
    data: { status, closedAt: status === "CLOSED" ? now() : null, wasPending: v.wasPending || status === "PENDING" },
  });
  await audit(actor, "FIELD_EDIT", "vacancy", vacancyId, { status: { from: v.status, to: status } }, db);
  return u;
}

/** Ranked Active leads for a vacancy (excluding already-submitted ones). */
export async function matchesFor(vacancyId: string, limit = 50, db: Tx = prisma) {
  const v = await db.vacancy.findUniqueOrThrow({ where: { id: vacancyId }, include: { submissions: { select: { candidateId: true } } } });
  const submitted = new Set(v.submissions.map((s) => s.candidateId));
  const pool = await db.candidate.findMany({ where: { stage: "ACTIVE", mainCategory: v.category, anonymizedAt: null, id: { notIn: [...submitted] } }, take: 2000 });
  return rankMatches(pool, v).slice(0, limit);
}

export type SourcingStats = {
  submissions: number;
  nt: number;
  nonNt: number;
  target: number;
  targetMet: boolean;
  tatMinutes: number | null;
  postToCalibrationMinutes: number | null;
  calibrationToTargetMinutes: number | null;
};

/** 5-CV target and TAT (posting → calibration → 5th CV), in minutes. */
export function sourcingStats(v: Vacancy & { submissions: { isNtSource: boolean; submittedAt: Date }[] }, target: number): SourcingStats {
  const subs = [...v.submissions].sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
  const nt = subs.filter((s) => s.isNtSource).length;
  const completed = v.sourcingCompletedAt ?? (subs.length >= target ? subs[target - 1].submittedAt : null);
  const mins = (a: Date | null, b: Date | null) => (a && b ? Math.round((b.getTime() - a.getTime()) / MINUTE) : null);
  return {
    submissions: subs.length,
    nt,
    nonNt: subs.length - nt,
    target,
    targetMet: subs.length >= target,
    tatMinutes: mins(v.postedAt, completed),
    postToCalibrationMinutes: mins(v.postedAt, v.calibratedAt),
    calibrationToTargetMinutes: mins(v.calibratedAt, completed),
  };
}

/**
 * Forward a CV to the recruiter (Active → Sourced). Consent is mandatory before
 * a CV leaves the system (DPDP).
 */
export async function submitCandidate(actor: Actor, vacancyId: string, candidateId: string, matchScore: number | null = null, db: Tx = prisma) {
  if (!hasRole(actor, "admin", "sourcer", "team2_leader")) throw new ForbiddenError("Only Team 2 submits CVs to vacancies");
  return withTx(db, async (tx) => {
    const v = await tx.vacancy.findUniqueOrThrow({ where: { id: vacancyId } });
    if (v.status === "CLOSED") throw new ValidationError("Vacancy is closed");
    const lead = await tx.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    if (!["ACTIVE", "SOURCED"].includes(lead.stage)) throw new ValidationError(`Only Active leads can be submitted (lead is ${lead.stage})`);
    if (!lead.consentRecordStoreShare) throw new ValidationError("Consent to store & share is required before the CV can be shared (DPDP)");
    if (lead.mainCategory !== v.category) throw new ValidationError("Candidate category does not match the vacancy");
    const existing = await tx.submission.findUnique({ where: { vacancyId_candidateId: { vacancyId, candidateId } } });
    if (existing) throw new ValidationError("Already submitted to this vacancy");
    const sub = await tx.submission.create({
      data: { vacancyId, candidateId, isNtSource: lead.isNtSource, submittedById: actorId(actor), submittedAt: now(), matchScore },
    });
    if (!v.calibratedAt) await tx.vacancy.update({ where: { id: vacancyId }, data: { calibratedAt: now() } });
    const settings = await getAllSettings(tx);
    const count = await tx.submission.count({ where: { vacancyId } });
    if (count >= settings.cvTargetPerVacancy && !v.sourcingCompletedAt) {
      await tx.vacancy.update({ where: { id: vacancyId }, data: { sourcingCompletedAt: now(), ...(v.status === "PENDING" ? { status: "OPEN" } : {}) } });
    }
    await audit(actor, "CREATE", "submission", sub.id, { vacancyId, candidateId, isNtSource: lead.isNtSource }, tx);
    if (lead.stage === "ACTIVE") {
      await transitionLead(actor, candidateId, "SOURCED", { note: `CV forwarded for ${v.code} ${v.title}` }, tx);
      if (v.recruiterId) {
        await tx.candidate.update({ where: { id: candidateId }, data: { ownerUserId: v.recruiterId } });
        await audit(actor, "REASSIGN", "candidate", candidateId, { from: lead.ownerUserId, to: v.recruiterId, reason: "Sourced to recruiter" }, tx);
      }
    }
    await notify(v.recruiterId, { kind: "LEAD_ASSIGNED", title: `CV submitted: ${lead.name}`, body: `${v.code} · ${v.title} — ${count} of ${settings.cvTargetPerVacancy} CVs`, link: `/vacancies/${vacancyId}` }, tx, actor);
    return sub;
  });
}

export async function decideSubmission(actor: Actor, submissionId: string, decision: "SHORTLISTED" | "REJECTED", db: Tx = prisma) {
  if (!hasRole(actor, "admin", "recruiter", "team3_leader")) throw new ForbiddenError();
  const s = await db.submission.update({ where: { id: submissionId }, data: { decision, decidedAt: now() } });
  await audit(actor, "FIELD_EDIT", "submission", submissionId, { decision }, db);
  return s;
}

/** Bulk "invite to apply" to matched Active leads. */
export async function inviteToApply(actor: Actor, vacancyId: string, candidateIds: string[], channel: "WHATSAPP" | "SMS" | "EMAIL", db: Tx = prisma) {
  if (!hasRole(actor, "admin", "sourcer", "team2_leader", "recruiter", "team3_leader")) throw new ForbiddenError();
  const v = await db.vacancy.findUniqueOrThrow({ where: { id: vacancyId }, include: { clientOrg: true } });
  let sent = 0;
  const errors: string[] = [];
  for (const id of candidateIds) {
    try {
      const lead = await db.candidate.findUniqueOrThrow({ where: { id } });
      if (lead.stage !== "ACTIVE") throw new ValidationError(`${lead.candidateCode} is not Active`);
      await sendTemplate(actor, id, `invite_to_apply_${channel.toLowerCase()}`, channel, { role: v.title, org: v.clientOrg.name, location: v.location }, db);
      sent++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { sent, errors };
}
