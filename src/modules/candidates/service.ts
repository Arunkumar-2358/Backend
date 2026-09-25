import type { Candidate, Prisma } from "@prisma/client";
import { prisma, withTx, type Tx } from "@/lib/db";
import { encrypt, decrypt, blindIndex } from "@/lib/crypto";
import { validateMobile } from "@contracts/shared/phone";
import { audit, diffFields } from "@/lib/audit";
import { canEditLead, type Actor, ForbiddenError, actorId } from "@/lib/rbac";
import { getSetting } from "@/lib/settings";
import { ValidationError } from "@/lib/errors";
import { now } from "@/lib/clock";
import { completenessPct, isNtSourceFor, type CandidatePlain } from "@contracts/shared/fields";

export async function nextCandidateCode(db: Tx = prisma): Promise<string> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT nextval('candidate_code_seq') AS n`;
  return `NTC${String(rows[0].n).padStart(6, "0")}`;
}

export function decryptCandidate<T extends Candidate>(c: T): T & CandidatePlain {
  return {
    ...c,
    mobile: decrypt(c.mobileEnc),
    altMobile: decrypt(c.altMobileEnc),
    email: decrypt(c.emailEnc),
  } as T & CandidatePlain;
}

export function mobileHashOf(mobile: string) {
  return blindIndex(mobile);
}
export function emailHashOf(email: string) {
  return blindIndex(email);
}

export async function findByMobile(mobile: string, db: Tx = prisma) {
  return db.candidate.findUnique({ where: { mobileHash: mobileHashOf(mobile) } });
}
export async function findByEmail(email: string, db: Tx = prisma) {
  return db.candidate.findFirst({ where: { emailHash: emailHashOf(email) } });
}

const PLAIN_KEYS = [
  "name", "basicQualification", "additionalQualifications", "registrationNumber", "registrationAuthority", "registrationYear",
  "mainCategory", "professionFunctionalHead", "jobTitle", "primarySpecialty", "secondarySkills", "experienceYears", "currentOrg",
  "currentDesignation", "currentLocation", "preferredLocations", "currentCtcLakhs", "expectedCtcLakhs", "noticePeriodDays",
  "earliestAvailabilityDate", "availabilityStatus", "shiftPreference", "employmentPreference", "source", "resumeFileKey",
  "resumeFileName", "introVideoKey", "consentRecordStoreShare", "tlRemarks",
] as const;

export type CandidateInput = Partial<Record<(typeof PLAIN_KEYS)[number], unknown>> & {
  mobile?: string | null;
  altMobile?: string | null;
  email?: string | null;
};

/** Convert user input into Prisma data (encrypting contact fields). */
export function toCandidateData(input: CandidateInput): Prisma.CandidateUncheckedUpdateInput {
  const data: Record<string, unknown> = {};
  for (const k of PLAIN_KEYS) if (k in input) data[k] = input[k];
  if (input.mobile !== undefined) {
    const m = validateMobile(input.mobile);
    if (!m.ok) throw new ValidationError(m.reason);
    data.mobileEnc = encrypt(m.mobile);
    data.mobileHash = mobileHashOf(m.mobile);
    data.mobileLast4 = m.mobile.slice(-4);
  }
  if (input.altMobile !== undefined) {
    if (input.altMobile) {
      const m = validateMobile(input.altMobile);
      if (!m.ok) throw new ValidationError(`Alternate mobile: ${m.reason}`);
      data.altMobileEnc = encrypt(m.mobile);
    } else data.altMobileEnc = null;
  }
  if (input.email !== undefined) {
    const e = input.email?.trim().toLowerCase() || null;
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new ValidationError(`Invalid email "${e}"`);
    data.emailEnc = e ? encrypt(e) : null;
    data.emailHash = e ? emailHashOf(e) : null;
  }
  if ("source" in input && input.source) data.isNtSource = isNtSourceFor(String(input.source));
  if (input.consentRecordStoreShare === true) data.consentAt = now();
  if (input.consentRecordStoreShare === false) data.consentAt = null;
  return data as Prisma.CandidateUncheckedUpdateInput;
}

export async function recomputeCompleteness(candidateId: string, db: Tx = prisma): Promise<number> {
  const c = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
  const mandatory = await getSetting("mandatorySopFields", db);
  const pct = completenessPct(decryptCandidate(c), mandatory);
  if (pct !== c.profileCompletenessPct) {
    await db.candidate.update({
      where: { id: candidateId },
      data: { profileCompletenessPct: pct, ...(pct < 100 && c.verificationStatus === "COMPLETE_VERIFIED" ? { verificationStatus: "INCOMPLETE" } : {}) },
    });
  }
  // A complete profile resolves any open "collect details" task automatically
  if (pct === 100) {
    await db.task.updateMany({
      where: { candidateId, type: "COLLECT_DETAILS", status: "OPEN" },
      data: { status: "DONE", completedAt: now(), result: "Profile complete" },
    });
  }
  return pct;
}

/**
 * Create a lead. New leads always start in MAPPING; callers (import, webhook,
 * manual entry) then call transitionLead to move them on so history is recorded.
 */
export async function createCandidate(actor: Actor, input: CandidateInput & { name: string; mobile: string }, opts: { importBatchId?: string; ownerUserId?: string | null } = {}, db: Tx = prisma) {
  return withTx(db, (tx) => createCandidateTx(actor, input, opts, tx));
}

async function createCandidateTx(actor: Actor, input: CandidateInput & { name: string; mobile: string }, opts: { importBatchId?: string; ownerUserId?: string | null }, db: Tx) {
  const m = validateMobile(input.mobile);
  if (!m.ok) throw new ValidationError(m.reason);
  const existing = await findByMobile(m.mobile, db);
  if (existing) throw new ValidationError(`A candidate with mobile ••••${m.mobile.slice(-4)} already exists (${existing.candidateCode})`);
  if (input.email) {
    const byEmail = await findByEmail(String(input.email), db);
    if (byEmail) throw new ValidationError(`A candidate with this email already exists (${byEmail.candidateCode})`);
  }
  const data = toCandidateData(input) as Prisma.CandidateUncheckedCreateInput;
  const created = await db.candidate.create({
    data: {
      ...data,
      isNtSource: isNtSourceFor(String(input.source ?? "OTHER")),
      name: input.name,
      candidateCode: await nextCandidateCode(db),
      stage: "MAPPING",
      stageChangedAt: now(),
      duplicateCheckStatus: "UNIQUE",
      importBatchId: opts.importBatchId,
      ownerUserId: opts.ownerUserId ?? null,
      createdById: actorId(actor),
      createdAt: now(),
    } as Prisma.CandidateUncheckedCreateInput,
  });
  await db.leadStageHistory.create({
    data: { candidateId: created.id, fromStage: null, toStage: "MAPPING", byUserId: actorId(actor), bySystem: actor.kind === "system" ? actor.label : null, at: now(), note: "Lead created", ownerUserId: created.ownerUserId },
  });
  await recomputeCompleteness(created.id, db);
  await audit(actor, "CREATE", "candidate", created.id, { candidateCode: created.candidateCode, source: created.source }, db);
  return created;
}

export async function updateCandidate(actor: Actor, id: string, input: CandidateInput, db: Tx = prisma) {
  const before = await db.candidate.findUniqueOrThrow({ where: { id } });
  if (!canEditLead(actor, before)) throw new ForbiddenError("You can only edit leads you own or that your team owns");
  if (input.mobile !== undefined && input.mobile) {
    const m = validateMobile(input.mobile);
    if (m.ok) {
      const clash = await findByMobile(m.mobile, db);
      if (clash && clash.id !== id) throw new ValidationError(`Mobile already belongs to ${clash.candidateCode}`);
    }
  }
  if (input.email) {
    const clash = await findByEmail(String(input.email), db);
    if (clash && clash.id !== id) throw new ValidationError(`Email already belongs to ${clash.candidateCode}`);
  }
  const data = toCandidateData(input);
  if (input.consentRecordStoreShare === true && before.consentRecordStoreShare) delete (data as Record<string, unknown>).consentAt;
  const beforePlain = decryptCandidate(before);
  const after = await db.candidate.update({ where: { id }, data });
  const afterPlain = decryptCandidate(after);
  const keys = [...Object.keys(input)];
  const diff = diffFields(
    Object.fromEntries(keys.map((k) => [k, beforePlain[k]])),
    Object.fromEntries(keys.map((k) => [k, afterPlain[k]])),
  );
  // Never write plaintext contact details into the audit log
  for (const k of ["mobile", "altMobile", "email"]) if (diff[k]) diff[k] = { from: "•••", to: "•••" };
  if (Object.keys(diff).length) await audit(actor, "FIELD_EDIT", "candidate", id, diff, db);
  await recomputeCompleteness(id, db);
  return after;
}

export async function reassignLead(actor: Actor, id: string, toUserId: string, db: Tx = prisma) {
  const lead = await db.candidate.findUniqueOrThrow({ where: { id } });
  const { isStageLeader } = await import("@/lib/rbac");
  if (!isStageLeader(actor, lead.stage)) throw new ForbiddenError("Only the team leader of this stage can reassign");
  const { STAGE_OWNER_TEAMS } = await import("@/lib/rbac");
  const target = await db.user.findUnique({ where: { id: toUserId }, include: { roles: { include: { team: true } } } });
  if (!target || !target.active) throw new ValidationError("The new owner must be an active user");
  if (STAGE_OWNER_TEAMS[lead.stage].length && !target.roles.some((r) => STAGE_OWNER_TEAMS[lead.stage].includes(r.team.code)))
    throw new ValidationError("The new owner must belong to the team that owns this stage");
  await db.candidate.update({ where: { id }, data: { ownerUserId: toUserId } });
  await db.task.updateMany({ where: { candidateId: id, status: "OPEN", assigneeId: lead.ownerUserId }, data: { assigneeId: toUserId } });
  await audit(actor, "REASSIGN", "candidate", id, { from: lead.ownerUserId, to: toUserId }, db);
  const { notify } = await import("@/modules/notifications/service");
  await notify(toUserId, { kind: "LEAD_ASSIGNED", title: `Lead reassigned to you: ${lead.name}`, body: `${lead.candidateCode} · ${lead.stage}`, link: `/leads/${id}` }, db, actor);
}

/** Access log for PII views (DPDP). */
export async function logPiiView(actor: Actor, id: string) {
  await audit(actor, "VIEW_PII", "candidate", id);
}

/**
 * DPDP data-deletion: anonymise PII while keeping aggregate events for KPIs.
 */
export async function processDeletionRequest(actor: Actor, requestId: string, db: Tx = prisma) {
  const req = await db.dataDeletionRequest.findUniqueOrThrow({ where: { id: requestId } });
  const c = await db.candidate.findUniqueOrThrow({ where: { id: req.candidateId } });
  const tomb = `deleted-${c.id}`;
  await db.candidate.update({
    where: { id: c.id },
    data: {
      name: "[deleted]",
      mobileEnc: encrypt("0000000000"),
      mobileHash: blindIndex(tomb),
      mobileLast4: "0000",
      altMobileEnc: null,
      emailEnc: null,
      emailHash: null,
      registrationNumber: null,
      resumeFileKey: null,
      resumeFileName: null,
      introVideoKey: null,
      currentOrg: null,
      tlRemarks: null,
      consentRecordStoreShare: false,
      consentAt: null,
      anonymizedAt: now(),
    },
  });
  await db.contactAttempt.updateMany({ where: { candidateId: c.id }, data: { notes: null } });
  await db.message.updateMany({ where: { candidateId: c.id }, data: { body: "[deleted]", toAddress: "[deleted]" } });
  await db.dataDeletionRequest.update({ where: { id: requestId }, data: { status: "COMPLETED", processedAt: now(), processedById: actorId(actor) } });
  await audit(actor, "DATA_DELETION", "candidate", c.id, { requestId }, db);
}

export async function requestDataDeletion(actor: Actor, candidateId: string, input: { requestedVia?: string; reason?: string }, db: Tx = prisma) {
  const r = await db.dataDeletionRequest.create({ data: { candidateId, requestedVia: input.requestedVia, reason: input.reason, requestedAt: now() } });
  await audit(actor, "DATA_DELETION", "candidate", candidateId, { requestId: r.id, action: "requested" }, db);
  return r;
}
