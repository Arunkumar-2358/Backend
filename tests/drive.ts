/** Push a lead through the real services to a given stage (test fixture builder). */
import { prisma } from "@/lib/db";
import { now, advanceClock, DAY, HOUR } from "@/lib/clock";
import { SYSTEM } from "@/lib/rbac";
import type { Stage } from "@prisma/client";
import { transitionLead } from "@/modules/lifecycle/transition";
import { logContact } from "@/modules/outreach/service";
import { verifyAndQualify, recordAvailabilityCheck } from "@/modules/scrutiny/service";
import { createVacancy, submitCandidate } from "@/modules/vacancies/service";
import { scheduleInterview, recordInterviewOutcome, sendOffer, confirmJoiningDate, recordJoining, completeFormalities, recordRetentionCheck } from "@/modules/interviews/service";
import type { CandidateInput } from "@/modules/candidates/service";
import { allocateQualified } from "@/modules/allocation/service";
import { pickAssignee } from "@/modules/users/assignment";
import { as, newLead } from "./helpers";

export async function ownerActor(leadId: string) {
  const c = await prisma.candidate.findUniqueOrThrow({ where: { id: leadId }, include: { owner: true } });
  return as(c.owner!.email.split("@")[0]);
}

export async function orgId(type: "GENERAL" | "EXISTING" | "FREE_TRIAL") {
  return (await prisma.clientOrg.findFirstOrThrow({ where: { type } })).id;
}

export async function makeVacancy(overrides: Partial<Parameters<typeof createVacancy>[1]> = {}, type: "GENERAL" | "EXISTING" | "FREE_TRIAL" = "GENERAL") {
  return createVacancy(await as("dixha"), { clientOrgId: await orgId(type), title: "Staff Nurse – ICU", category: "NURSE", specialty: "ICU", location: "Hyderabad", minExperienceYears: 2, ctcMaxLakhs: 5, maxNoticeDays: 30, openings: 1, ...overrides });
}

const ORDER: Stage[] = ["MAPPING", "VALIDATED", "ENROLLED", "QUALIFIED", "ACTIVE", "SOURCED", "SELECTED", "JOINED", "SUCCESSFUL"];

/** Team 3 leader hands a qualified lead to the Team 2 sourcer the assignment rules pick. */
export async function allocate(leadId: string) {
  const c = await prisma.candidate.findUniqueOrThrow({ where: { id: leadId } });
  const sourcerId = (await pickAssignee("T2", c.mainCategory))!;
  return allocateQualified(await as("sanjay"), { sourcerId, ids: [leadId] });
}

/** `allocate: false` leaves a Qualified lead in the Team 3 leader's pool. */
export async function driveTo(target: Stage, overrides: CandidateInput = {}, ctx: { vacancyId?: string; allocate?: boolean } = {}) {
  const lead = await newLead(overrides);
  const id = lead.id;
  const reach = (s: Stage) => ORDER.indexOf(target) >= ORDER.indexOf(s);
  let vacancyId = ctx.vacancyId;
  if (reach("VALIDATED")) await transitionLead(SYSTEM("import"), id, "VALIDATED");
  if (reach("ENROLLED")) await logContact(await ownerActor(id), id, { channel: "CALL", outcome: "ENROLLED" });
  if (reach("QUALIFIED")) await verifyAndQualify(await as("dixha"), id, "Verified");
  if (reach("QUALIFIED") && (ctx.allocate ?? true)) await allocate(id);
  if (reach("ACTIVE")) await recordAvailabilityCheck(await ownerActor(id), id, true, undefined);
  if (reach("SOURCED")) {
    vacancyId ??= (await makeVacancy()).id;
    await submitCandidate(await as("dixha"), vacancyId, id);
  }
  let submissionId: string | undefined;
  if (reach("SELECTED")) {
    const sub = await prisma.submission.findFirstOrThrow({ where: { candidateId: id } });
    submissionId = sub.id;
    const iv = await scheduleInterview(await as("sanjay"), sub.id, { scheduledAt: new Date(now().getTime() + 2 * DAY) });
    advanceClock(2 * DAY + HOUR);
    await recordInterviewOutcome(await as("sanjay"), iv.id, { status: "ATTENDED", result: "SELECTED" });
  }
  let joiningId: string | undefined;
  if (reach("JOINED")) {
    const offer = await sendOffer(await as("sanjay"), submissionId!, { ctcLakhs: 4.5 });
    await confirmJoiningDate(await as("sanjay"), offer.id, new Date(now().getTime() + DAY));
    advanceClock(DAY);
    joiningId = (await recordJoining(await as("sanjay"), offer.id, now())).id;
  }
  if (reach("SUCCESSFUL")) {
    await completeFormalities(await as("sanjay"), joiningId!);
    advanceClock(7 * DAY);
    await recordRetentionCheck(await as("sanjay"), joiningId!, 7, true, undefined);
    advanceClock(23 * DAY);
    await recordRetentionCheck(await as("sanjay"), joiningId!, 30, true, undefined);
  }
  return { id, vacancyId, submissionId, joiningId };
}
