import { describe, it, expect, beforeEach } from "vitest";
import type { Stage } from "@prisma/client";
import { prisma } from "@/lib/db";
import { setClock, advanceClock, now, DAY, HOUR } from "@/lib/clock";
import { SYSTEM } from "@/lib/rbac";
import { GateError } from "@/lib/errors";
import { transitionLead } from "@/modules/lifecycle/transition";
import { PIPELINE, NEXT_STAGE, EXITS, TERMINAL_STAGES, allowedTargets } from "@/modules/lifecycle/rules";
import { logContact, handleNtEnrolment, allocateToTelecaller } from "@/modules/outreach/service";
import { verifyAndQualify, recordAvailabilityCheck, scrutinize } from "@/modules/scrutiny/service";
import { updateCandidate } from "@/modules/candidates/service";
import { submitCandidate } from "@/modules/vacancies/service";
import { scheduleInterview, recordInterviewOutcome, recordRetentionCheck } from "@/modules/interviews/service";
import { runDueJobs } from "@/modules/jobs/runner";
import { resetDb, as, userId, newLead, stageOf, memory } from "./helpers";
import { driveTo, ownerActor, makeVacancy } from "./drive";

beforeEach(async () => {
  await resetDb();
  setClock("2026-09-21T04:30:00Z"); // Mon 10:00 IST
});

describe("transition legality", () => {
  it("allows only the next stage or a listed exit from every stage", () => {
    const all: Stage[] = [...PIPELINE, "NOT_INTERESTED", "UNREACHABLE", "DUPLICATE", "INVALID", "DROPPED"];
    for (const from of all) {
      const allowed = allowedTargets(from);
      const expected = [...(NEXT_STAGE[from] ? [NEXT_STAGE[from]!] : []), ...(EXITS[from] ?? [])];
      expect(allowed.sort()).toEqual(expected.sort());
    }
    for (const t of TERMINAL_STAGES) expect(allowedTargets(t)).toEqual([]);
  });

  it("rejects skipping a stage (every non-adjacent forward jump)", async () => {
    const lead = await newLead();
    for (let i = 0; i < PIPELINE.length; i++) {
      for (let j = i + 2; j < PIPELINE.length; j++) {
        await prisma.candidate.update({ where: { id: lead.id }, data: { stage: PIPELINE[i] } });
        await expect(transitionLead(SYSTEM("t"), lead.id, PIPELINE[j])).rejects.toThrow(/Cannot move/);
      }
    }
  });

  it("rejects moving backwards and out of terminal stages", async () => {
    const lead = await newLead();
    await transitionLead(SYSTEM("t"), lead.id, "VALIDATED");
    await expect(transitionLead(SYSTEM("t"), lead.id, "MAPPING")).rejects.toThrow(GateError);
    await prisma.candidate.update({ where: { id: lead.id }, data: { stage: "SUCCESSFUL" } });
    await expect(transitionLead(SYSTEM("t"), lead.id, "DROPPED", { dropReason: "OTHER" })).rejects.toThrow(/terminal/);
  });

  it("writes stage history and audit rows for each transition", async () => {
    const { id } = await driveTo("QUALIFIED");
    const hist = await prisma.leadStageHistory.findMany({ where: { candidateId: id }, orderBy: { at: "asc" } });
    expect(hist.map((h) => h.toStage)).toEqual(["MAPPING", "VALIDATED", "ENROLLED", "QUALIFIED"]);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: "STAGE_CHANGE" } })).toBe(3);
  });
});

describe("MAPPING → VALIDATED gate", () => {
  it("requires category, job title and geography", async () => {
    const lead = await newLead({ mainCategory: null, currentLocation: null, preferredLocations: [], jobTitle: null, primarySpecialty: null });
    const err = await transitionLead(SYSTEM("t"), lead.id, "VALIDATED").catch((e) => e);
    expect(err).toBeInstanceOf(GateError);
    expect(err.failures.join()).toMatch(/category/);
    expect(err.failures.join()).toMatch(/Geography/);
    expect(err.failures.join()).toMatch(/Job title/);
  });
  it("requires the duplicate check to have passed", async () => {
    const lead = await newLead();
    await prisma.candidate.update({ where: { id: lead.id }, data: { duplicateCheckStatus: "DUPLICATE" } });
    await expect(transitionLead(SYSTEM("t"), lead.id, "VALIDATED")).rejects.toThrow(/Duplicate/);
  });
  it("routes to the Team 1a TA lead by category and creates a first-contact task", async () => {
    const lead = await newLead({ mainCategory: "NURSE" });
    await transitionLead(SYSTEM("t"), lead.id, "VALIDATED");
    const c = await prisma.candidate.findUniqueOrThrow({ where: { id: lead.id } });
    expect(c.ownerUserId).toBe(await userId("jennifer"));
    expect(await prisma.task.count({ where: { candidateId: lead.id, type: "FOLLOW_UP", status: "OPEN", assigneeId: await userId("jennifer") } })).toBe(1);
  });
});

describe("VALIDATED → ENROLLED and outreach outcomes", () => {
  it("cannot enrol without an ENROLLED contact attempt", async () => {
    const { id } = await driveTo("VALIDATED");
    await expect(transitionLead(await as("jennifer"), id, "ENROLLED")).rejects.toThrow(/ENROLLED/);
  });
  it("Bb creates a follow-up task and Bc creates a recall task", async () => {
    const { id } = await driveTo("VALIDATED");
    const j = await as("jennifer");
    await logContact(j, id, { channel: "WHATSAPP", outcome: "INTERESTED_LINK_SENT_NOT_REGISTERED" });
    let open = await prisma.task.findMany({ where: { candidateId: id, status: "OPEN" } });
    expect(open).toHaveLength(1);
    expect(open[0].type).toBe("FOLLOW_UP");
    expect(open[0].dueAt.getTime()).toBe(now().getTime() + 48 * HOUR);
    await logContact(j, id, { channel: "CALL", outcome: "BUSY_RECALL_REQUESTED" });
    open = await prisma.task.findMany({ where: { candidateId: id, status: "OPEN" } });
    expect(open).toHaveLength(1);
    expect(open[0].type).toBe("RECALL");
    expect(await stageOf(id)).toBe("VALIDATED");
  });
  it("uses an explicit next follow-up time when given", async () => {
    const { id } = await driveTo("VALIDATED");
    const at = new Date(now().getTime() + 3 * DAY);
    await logContact(await as("jennifer"), id, { channel: "CALL", outcome: "UNANSWERED", nextFollowupAt: at });
    const t = await prisma.task.findFirstOrThrow({ where: { candidateId: id, status: "OPEN" } });
    expect(t.dueAt.getTime()).toBe(at.getTime());
  });
  it("marks the lead Unreachable after the attempt cap (5)", async () => {
    const { id } = await driveTo("VALIDATED");
    const j = await as("jennifer");
    for (let i = 0; i < 4; i++) await logContact(j, id, { channel: "CALL", outcome: "UNANSWERED" });
    expect(await stageOf(id)).toBe("VALIDATED");
    const r = await logContact(j, id, { channel: "CALL", outcome: "UNANSWERED" });
    expect(r.transitioned).toBe("UNREACHABLE");
    expect(await stageOf(id)).toBe("UNREACHABLE");
    expect(await prisma.task.count({ where: { candidateId: id, status: "OPEN" } })).toBe(0);
  });
  it("Unreachable gate refuses before the cap", async () => {
    const { id } = await driveTo("VALIDATED");
    await expect(transitionLead(await as("jennifer"), id, "UNREACHABLE")).rejects.toThrow(/of 5/);
  });
  it("NOT_INTERESTED outcome exits the lead", async () => {
    const { id } = await driveTo("VALIDATED");
    await logContact(await as("jennifer"), id, { channel: "CALL", outcome: "NOT_INTERESTED" });
    expect(await stageOf(id)).toBe("NOT_INTERESTED");
  });
  it("ENROLLED outcome enrols and routes to the Team 2 sourcer", async () => {
    const { id } = await driveTo("VALIDATED", { mainCategory: "PHARMACY", primarySpecialty: "Retail" });
    const owner = await ownerActor(id);
    expect(owner.kind === "user" && owner.name).toBe("Poojitha");
    await logContact(owner, id, { channel: "CALL", outcome: "ENROLLED" });
    const c = await prisma.candidate.findUniqueOrThrow({ where: { id } });
    expect(c.stage).toBe("ENROLLED");
    expect(c.ownerUserId).toBe(await userId("amos"));
  });
  it("another agent cannot work a lead they do not own", async () => {
    const { id } = await driveTo("VALIDATED", { mainCategory: "NURSE" });
    await expect(logContact(await as("poojitha"), id, { channel: "CALL", outcome: "ENROLLED" })).rejects.toThrow(/own/);
    await expect(transitionLead(await as("bhavani"), id, "NOT_INTERESTED", { note: "x" })).rejects.toThrow(/own/);
  });
  it("a tele-caller allocated the lead can enrol it", async () => {
    const { id } = await driveTo("VALIDATED");
    await allocateToTelecaller(await as("sarala"), [id], await userId("bhavani"));
    await logContact(await as("bhavani"), id, { channel: "CALL", outcome: "ENROLLED", isFirstTimeVerifiedCall: true });
    expect(await stageOf(id)).toBe("ENROLLED");
  });
  it("NT webhook enrols an existing validated lead and creates unknown registrants", async () => {
    const { id } = await driveTo("VALIDATED");
    const c = await prisma.candidate.findUniqueOrThrow({ where: { id } });
    const { decrypt } = await import("@/lib/crypto");
    const r = await handleNtEnrolment({ mobile: `+91 ${decrypt(c.mobileEnc)}` });
    expect(r.stage).toBe("ENROLLED");
    const r2 = await handleNtEnrolment({ mobile: "8123456789", name: "New Person", mainCategory: "NURSE", currentLocation: "Chennai", jobTitle: "Staff Nurse" });
    expect(r2.created).toBe(true);
    expect(r2.stage).toBe("ENROLLED");
    const r3 = await handleNtEnrolment({ mobile: "8123456780", name: "No Category" });
    expect(r3.stage).toBe("MAPPING");
  });
});

describe("ENROLLED → QUALIFIED gate", () => {
  it("an incomplete profile cannot be qualified and gets a collect-details task", async () => {
    const { id } = await driveTo("ENROLLED", { registrationNumber: null, resumeFileKey: null });
    expect(await prisma.task.count({ where: { candidateId: id, type: "COLLECT_DETAILS", status: "OPEN" } })).toBe(1);
    await expect(verifyAndQualify(await as("dixha"), id, "ok")).rejects.toThrow(/complete/);
    const check = await scrutinize(await as("srividya"), id);
    expect(check.missing.sort()).toEqual(["registrationNumber", "resumeFileKey"]);
    await updateCandidate(await as("srividya"), id, { registrationNumber: "R-1", resumeFileKey: "resumes/x.pdf" });
    expect(await prisma.task.count({ where: { candidateId: id, type: "COLLECT_DETAILS", status: "OPEN" } })).toBe(0);
    await verifyAndQualify(await as("dixha"), id, "All good");
    const c = await prisma.candidate.findUniqueOrThrow({ where: { id } });
    expect(c.stage).toBe("QUALIFIED");
    expect(c.verificationStatus).toBe("COMPLETE_VERIFIED");
    expect(c.tlRemarks).toBe("All good");
  });
  it("only the Team 2 leader can sign off", async () => {
    const { id } = await driveTo("ENROLLED");
    await expect(verifyAndQualify(await as("srividya"), id, "x")).rejects.toThrow(/leader/);
  });
});

describe("QUALIFIED ↔ availability (cold / warm)", () => {
  it("not available → cold and stays Qualified; later available → Active (cold → warm)", async () => {
    const { id } = await driveTo("QUALIFIED");
    const sv = await ownerActor(id);
    await expect(transitionLead(sv, id, "ACTIVE")).rejects.toThrow(/availability/);
    await recordAvailabilityCheck(sv, id, false, "Not now");
    let c = await prisma.candidate.findUniqueOrThrow({ where: { id } });
    expect(c.stage).toBe("QUALIFIED");
    expect(c.isCold).toBe(true);
    await recordAvailabilityCheck(sv, id, true, undefined);
    c = await prisma.candidate.findUniqueOrThrow({ where: { id } });
    expect(c.stage).toBe("ACTIVE");
    expect(c.isCold).toBe(false);
    expect(await prisma.availabilityCheck.count({ where: { candidateId: id, available: true, wasCold: true } })).toBe(1);
  });

  it("fires the 60-day availability check-in (fake clock)", async () => {
    const { id } = await driveTo("QUALIFIED");
    await recordAvailabilityCheck(await ownerActor(id), id, false, undefined); // closes the initial task, goes cold
    expect(await prisma.task.count({ where: { candidateId: id, type: "AVAILABILITY_CHECK", status: "OPEN" } })).toBe(0);
    advanceClock(59 * DAY);
    await runDueJobs();
    expect(await prisma.task.count({ where: { candidateId: id, type: "AVAILABILITY_CHECK", status: "OPEN" } })).toBe(0);
    advanceClock(1 * DAY + 60_000);
    const ran = await runDueJobs();
    expect(ran.some((r) => r.type === "availability_check" && r.result === "task created")).toBe(true);
    const t = await prisma.task.findFirstOrThrow({ where: { candidateId: id, type: "AVAILABILITY_CHECK", status: "OPEN" } });
    expect(t.title).toMatch(/cold/);
    // and it re-schedules itself for another 60 days
    const next = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: `avail:${id}` } });
    expect(next.status).toBe("PENDING");
    expect(Math.round((next.runAt.getTime() - now().getTime()) / DAY)).toBe(60);
  });
});

describe("ACTIVE → SOURCED", () => {
  it("requires a submission and consent", async () => {
    const { id } = await driveTo("ACTIVE");
    await expect(transitionLead(await ownerActor(id), id, "SOURCED")).rejects.toThrow(/submission/);
    const v = await makeVacancy();
    await prisma.candidate.update({ where: { id }, data: { consentRecordStoreShare: false } });
    await expect(submitCandidate(await as("dixha"), v.id, id)).rejects.toThrow(/Consent/);
    await prisma.candidate.update({ where: { id }, data: { consentRecordStoreShare: true } });
    await submitCandidate(await as("dixha"), v.id, id);
    const c = await prisma.candidate.findUniqueOrThrow({ where: { id } });
    expect(c.stage).toBe("SOURCED");
    expect(c.ownerUserId).toBe(await userId("harsha"));
  });
});

describe("SOURCED → SELECTED with reminders", () => {
  it("schedules T-24h and T-2h reminders and needs an attended, selected interview", async () => {
    const { id } = await driveTo("SOURCED");
    const sub = await prisma.submission.findFirstOrThrow({ where: { candidateId: id } });
    await expect(transitionLead(await as("harsha"), id, "SELECTED")).rejects.toThrow(/interview/);
    const at = new Date(now().getTime() + 3 * DAY);
    const iv = await scheduleInterview(await as("harsha"), sub.id, { scheduledAt: at });
    const jobs = await prisma.scheduledJob.findMany({ where: { type: "interview_reminder", status: "PENDING" }, orderBy: { runAt: "asc" } });
    expect(jobs.map((j) => (at.getTime() - j.runAt.getTime()) / HOUR)).toEqual([24, 2]);
    memory.sent = [];
    setClock(new Date(at.getTime() - 24 * HOUR));
    await runDueJobs();
    setClock(new Date(at.getTime() - 2 * HOUR));
    await runDueJobs();
    expect(memory.sent.filter((m) => /Reminder/.test(m.body))).toHaveLength(2);
    expect((await prisma.interview.findUniqueOrThrow({ where: { id: iv.id } })).remindersSent).toBe(2);
    setClock(new Date(at.getTime() + HOUR));
    await recordInterviewOutcome(await as("harsha"), iv.id, { status: "ATTENDED", result: "SELECTED" });
    expect(await stageOf(id)).toBe("SELECTED");
  });
  it("a no-show drops the lead with a reason code", async () => {
    const { id } = await driveTo("SOURCED");
    const sub = await prisma.submission.findFirstOrThrow({ where: { candidateId: id } });
    const iv = await scheduleInterview(await as("harsha"), sub.id, { scheduledAt: new Date(now().getTime() + DAY) });
    advanceClock(DAY + HOUR);
    await recordInterviewOutcome(await as("harsha"), iv.id, { status: "NO_SHOW" });
    const c = await prisma.candidate.findUniqueOrThrow({ where: { id } });
    expect(c.stage).toBe("DROPPED");
    expect(c.dropReason).toBe("INTERVIEW_NO_SHOW");
    expect(await prisma.scheduledJob.count({ where: { type: "interview_reminder", status: "PENDING" } })).toBe(0);
  });
});

describe("SELECTED → JOINED → SUCCESSFUL", () => {
  it("day-7 and day-30 checks move the lead to Successful and close the vacancy", async () => {
    const { id, joiningId, vacancyId } = await driveTo("JOINED");
    expect(await stageOf(id)).toBe("JOINED");
    await expect(transitionLead(await as("harsha"), id, "SUCCESSFUL")).rejects.toThrow(/Day-7/);
    // retention jobs create the tasks
    advanceClock(7 * DAY);
    await runDueJobs();
    expect(await prisma.task.count({ where: { candidateId: id, type: "RETENTION_CHECK", status: "OPEN" } })).toBe(1);
    await recordRetentionCheck(await as("harsha"), joiningId!, 7, true, undefined);
    await expect(recordRetentionCheck(await as("harsha"), joiningId!, 30, true, undefined)).rejects.toThrow(/due/);
    advanceClock(23 * DAY);
    await runDueJobs();
    await recordRetentionCheck(await as("harsha"), joiningId!, 30, true, undefined);
    expect(await stageOf(id)).toBe("SUCCESSFUL");
    const v = await prisma.vacancy.findUniqueOrThrow({ where: { id: vacancyId! } });
    expect(v.openingsFilled).toBe(1);
    expect(v.status).toBe("CLOSED");
  });
  it("leaving before 30 days drops the lead", async () => {
    const { id, joiningId } = await driveTo("JOINED");
    advanceClock(7 * DAY);
    await recordRetentionCheck(await as("harsha"), joiningId!, 7, false, "Relocated");
    const c = await prisma.candidate.findUniqueOrThrow({ where: { id } });
    expect(c.stage).toBe("DROPPED");
    expect(c.dropReason).toBe("LEFT_BEFORE_30_DAYS");
  });
  it("the full pipeline reaches Successful", async () => {
    const { id } = await driveTo("SUCCESSFUL");
    const hist = await prisma.leadStageHistory.findMany({ where: { candidateId: id }, orderBy: { at: "asc" } });
    expect(hist.map((h) => h.toStage)).toEqual(PIPELINE);
  });
});

describe("exits", () => {
  it("DROPPED needs a reason code", async () => {
    const { id } = await driveTo("SOURCED");
    await expect(transitionLead(await as("harsha"), id, "DROPPED")).rejects.toThrow(/reason/);
    await transitionLead(await as("harsha"), id, "DROPPED", { dropReason: "OTHER" });
    expect(await stageOf(id)).toBe("DROPPED");
  });
  it("DUPLICATE / INVALID need a note", async () => {
    const lead = await newLead();
    await expect(transitionLead(await as("greeshma"), lead.id, "INVALID")).rejects.toThrow(/reason/);
    await transitionLead(await as("greeshma"), lead.id, "DUPLICATE", { note: "Same as NTC000001" });
    expect(await stageOf(lead.id)).toBe("DUPLICATE");
  });
});
