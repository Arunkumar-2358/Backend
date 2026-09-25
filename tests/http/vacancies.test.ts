import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { setClock, advanceClock, now, DAY, HOUR } from "@/lib/clock";
import { resetDb, stageOf } from "../helpers";
import { driveTo, makeVacancy, orgId } from "../drive";
import { call } from "./client";

beforeEach(async () => {
  await resetDb();
  setClock("2026-09-21T04:30:00Z"); // 10:00 IST
});

const post = (url: string, as: string, payload: object = {}) => call({ method: "POST", url, as, payload });

describe("HTTP: vacancies", () => {
  it("lists vacancies with sourcing stats, filters and ignores unknown filter values", async () => {
    const v = await makeVacancy();
    await makeVacancy({ title: "Pharmacist" }, "EXISTING");
    const res = await call({ method: "GET", url: "/v1/vacancies?status=BOGUS", as: "srividya" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.cvTargetPerVacancy).toBe(5);
    expect(body.orgs.length).toBeGreaterThan(0);
    const row = body.vacancies.find((x: { id: string }) => x.id === v.id);
    expect(row.stats).toMatchObject({ submissions: 0, target: 5, targetMet: false });
    expect(row.clientOrg.type).toBe("GENERAL");
    // "mine" = recruiter or sourcer; Harsha recruits Team 3a only.
    const mine = (await call({ method: "GET", url: "/v1/vacancies?mine=true", as: "harsha" })).json();
    expect(mine.vacancies.map((x: { id: string }) => x.id)).toEqual([v.id]);
    expect((await call({ method: "GET", url: "/v1/vacancies?q=Pharmacist", as: "harsha" })).json().total).toBe(1);
  });

  it("creates a vacancy for Teams 2/3 only and validates the intake", async () => {
    const clientOrgId = await orgId("GENERAL");
    const input = { clientOrgId, title: "Staff Nurse", category: "NURSE", location: "Hyderabad", openings: 2 };
    expect((await post("/v1/vacancies", "jennifer", input)).statusCode).toBe(403);
    const bad = await post("/v1/vacancies", "dixha", { ...input, title: "" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toBe("Title is required");
    const ctc = await post("/v1/vacancies", "dixha", { ...input, ctcMinLakhs: 6, ctcMaxLakhs: 4 });
    expect(ctc.json().error.message).toBe("CTC minimum is above the maximum");
    const ok = await post("/v1/vacancies", "dixha", input);
    expect(ok.statusCode).toBe(200);
    const v = await prisma.vacancy.findUniqueOrThrow({ where: { id: ok.json().id } });
    expect(v).toMatchObject({ routedTeam: "T3A", openings: 2, status: "OPEN" });
  });

  it("client orgs: listed and added by Teams 2/3 only; duplicates rejected", async () => {
    expect((await call({ method: "GET", url: "/v1/vacancies/client-orgs", as: "jennifer" })).statusCode).toBe(403);
    const list = await call({ method: "GET", url: "/v1/vacancies/client-orgs", as: "harsha" });
    expect(list.statusCode).toBe(200);
    expect(list.json()[0]).toHaveProperty("type");
    expect((await post("/v1/vacancies/client-orgs", "bhavani", { name: "New Org", type: "GENERAL" })).statusCode).toBe(403);
    const ok = await post("/v1/vacancies/client-orgs", "harsha", { name: "New Org", type: "EXISTING", city: "Pune" });
    expect(ok.json().message).toBe("Added New Org — vacancies will route to Team 3b · Existing clients");
    const dup = await post("/v1/vacancies/client-orgs", "harsha", { name: "New Org", type: "EXISTING" });
    expect(dup.statusCode).toBe(422);
    expect((await post("/v1/vacancies/client-orgs", "harsha", { name: "Other", type: "NOPE" })).json().error.message).toBe("Choose an organisation type");
  });

  it("returns the vacancy page with ranked matches (no encrypted PII) and 404s unknown ids", async () => {
    await driveTo("ACTIVE", { name: "Match Me" });
    const v = await makeVacancy();
    const res = await call({ method: "GET", url: `/v1/vacancies/${v.id}`, as: "harsha" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.vacancy.code).toBe(v.code);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].candidate.name).toBe("Match Me");
    expect(body.matches[0].candidate).not.toHaveProperty("mobileEnc");
    expect(body.matches[0].breakdown).toHaveProperty("specialty");
    expect((await call({ method: "GET", url: "/v1/vacancies/nope", as: "harsha" })).statusCode).toBe(404);
  });

  it("calibrates and changes status for Teams 2/3 only", async () => {
    const v = await makeVacancy();
    await prisma.vacancy.update({ where: { id: v.id }, data: { calibratedAt: null } });
    expect((await post(`/v1/vacancies/${v.id}/calibrate`, "jennifer")).statusCode).toBe(403);
    expect((await post(`/v1/vacancies/${v.id}/calibrate`, "harsha")).json().message).toBe("Vacancy calibrated");
    expect((await prisma.vacancy.findUniqueOrThrow({ where: { id: v.id } })).calibratedAt).not.toBeNull();

    expect((await post(`/v1/vacancies/${v.id}/status`, "jennifer", { status: "CLOSED" })).statusCode).toBe(403);
    const bad = await post(`/v1/vacancies/${v.id}/status`, "harsha", { status: "DONE" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toBe("Choose a status");
    expect((await post(`/v1/vacancies/${v.id}/status`, "harsha", { status: "CLOSED" })).json().message).toBe("Status set to closed");
    expect((await prisma.vacancy.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("CLOSED");
  });

  it("submits CVs (Team 2 only, partial failures reported) and invites to apply", async () => {
    const a = await driveTo("ACTIVE", { name: "Lead A" });
    const b = await driveTo("ACTIVE", { name: "Lead B" });
    const v = await makeVacancy();
    expect((await post(`/v1/vacancies/${v.id}/submissions`, "srividya", { candidates: [] })).json().error.message).toBe("Select at least one candidate");
    const denied = await post(`/v1/vacancies/${v.id}/submissions`, "harsha", { candidates: [{ id: a.id }] });
    expect(denied.statusCode).toBe(422);
    expect(denied.json().error.message).toMatch(/^0 CV\(s\) submitted; 1 failed — NTC\d+ Lead A: Only Team 2 submits CVs/);

    const ok = await post(`/v1/vacancies/${v.id}/submissions`, "srividya", { candidates: [{ id: a.id, matchScore: 90 }] });
    expect(ok.json().message).toBe("1 CV(s) submitted to the recruiter");
    expect(await stageOf(a.id)).toBe("SOURCED");
    expect((await prisma.submission.findFirstOrThrow({ where: { candidateId: a.id } })).matchScore).toBe(90);

    expect((await post(`/v1/vacancies/${v.id}/invites`, "srividya", { candidateIds: [b.id], channel: "FAX" })).json().error.message).toBe("Choose a channel");
    expect((await post(`/v1/vacancies/${v.id}/invites`, "jennifer", { candidateIds: [b.id], channel: "SMS" })).statusCode).toBe(403);
    expect((await post(`/v1/vacancies/${v.id}/invites`, "srividya", { candidateIds: [b.id], channel: "SMS" })).json().message).toBe("1 invite(s) sent by sms");
  });

  it("shortlists / rejects submissions for Team 3 only", async () => {
    const { submissionId } = await driveTo("SOURCED").then(async (l) => ({ submissionId: (await prisma.submission.findFirstOrThrow({ where: { candidateId: l.id } })).id }));
    const url = `/v1/vacancies/submissions/${submissionId}/decision`;
    expect((await post(url, "srividya", { decision: "SHORTLISTED" })).statusCode).toBe(403);
    expect((await post(url, "harsha", { decision: "MAYBE" })).statusCode).toBe(422);
    expect((await post(url, "harsha", { decision: "SHORTLISTED" })).json().message).toBe("Shortlisted");
    expect((await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } })).decision).toBe("SHORTLISTED");
  });
});

describe("HTTP: recruitment board", () => {
  it("scopes the board: leaders see all Team 3 vacancies, recruiters only their own", async () => {
    const lead = await driveTo("SOURCED", { name: "Board Lead" });
    const leader = (await call({ method: "GET", url: "/v1/recruitment", as: "sanjay" })).json();
    expect(leader.isLeader).toBe(true);
    expect(leader.reminderHours).toEqual([24, 2]);
    expect(leader.leads.map((l: { id: string }) => l.id)).toEqual([lead.id]);
    expect(leader.leads[0]).not.toHaveProperty("mobileEnc");
    expect(leader.leads[0].submissions[0].vacancy.clientOrg.name).toBeTruthy();
    const own = (await call({ method: "GET", url: "/v1/recruitment", as: "harsha" })).json();
    expect(own.isLeader).toBe(false);
    expect(own.leads).toHaveLength(1);
    const other = (await call({ method: "GET", url: "/v1/recruitment", as: "sampath" })).json();
    expect(other.leads).toHaveLength(0);
  });

  it("schedules, reschedules and records interview outcomes (Team 3 only)", async () => {
    const lead = await driveTo("SOURCED");
    const sub = await prisma.submission.findFirstOrThrow({ where: { candidateId: lead.id } });
    const at = new Date(now().getTime() + 2 * DAY).toISOString();
    expect((await post("/v1/recruitment/interviews", "harsha", { scheduledAt: at })).json().error.message).toBe("Choose the vacancy / submission");
    expect((await post("/v1/recruitment/interviews", "harsha", { submissionId: sub.id, scheduledAt: at, mode: "CARRIER_PIGEON" })).json().error.message).toBe("Unknown interview mode");
    expect((await post("/v1/recruitment/interviews", "harsha", { submissionId: sub.id, scheduledAt: "not a date" })).statusCode).toBe(422);
    expect((await post("/v1/recruitment/interviews", "srividya", { submissionId: sub.id, scheduledAt: at })).statusCode).toBe(403);
    const ok = await post("/v1/recruitment/interviews", "harsha", { submissionId: sub.id, scheduledAt: at, mode: "VIDEO", notes: "Zoom" });
    expect(ok.statusCode).toBe(200);
    const iv = await prisma.interview.findFirstOrThrow({ where: { submissionId: sub.id } });
    expect(iv.mode).toBe("VIDEO");

    const past = await post(`/v1/recruitment/interviews/${iv.id}/reschedule`, "harsha", { scheduledAt: new Date(now().getTime() - HOUR).toISOString() });
    expect(past.json().error.message).toBe("New interview time must be in the future");
    const later = new Date(now().getTime() + 3 * DAY);
    expect((await post(`/v1/recruitment/interviews/${iv.id}/reschedule`, "harsha", { scheduledAt: later.toISOString() })).statusCode).toBe(200);
    expect((await prisma.interview.findUniqueOrThrow({ where: { id: iv.id } })).scheduledAt.toISOString()).toBe(later.toISOString());

    expect((await post(`/v1/recruitment/interviews/${iv.id}/outcome`, "harsha", { outcome: "MAYBE" })).json().error.message).toBe("Choose an outcome");
    expect((await post(`/v1/recruitment/interviews/${iv.id}/outcome`, "srividya", { outcome: "SELECTED" })).statusCode).toBe(403);
    const sel = await post(`/v1/recruitment/interviews/${iv.id}/outcome`, "harsha", { outcome: "SELECTED" });
    expect(sel.json().message).toBe("Selected — lead moved to Selected");
    expect(await stageOf(lead.id)).toBe("SELECTED");
  });

  it("offers → joining → formalities → retention through the lifecycle", async () => {
    const lead = await driveTo("SELECTED");
    expect((await post("/v1/recruitment/offers", "harsha", {})).json().error.message).toBe("Choose the submission");
    expect((await post("/v1/recruitment/offers", "srividya", { submissionId: lead.submissionId })).statusCode).toBe(403);
    expect((await post("/v1/recruitment/offers", "harsha", { submissionId: lead.submissionId, ctcLakhs: 4.2, joiningDate: null })).json().message).toBe("Offer sent — follow-up task created");
    const offer = await prisma.offer.findFirstOrThrow({ where: { submissionId: lead.submissionId } });
    expect(offer.ctcLakhs).toBe(4.2);

    const joinDate = new Date(now().getTime() + DAY);
    expect((await post(`/v1/recruitment/offers/${offer.id}/confirm`, "harsha", { joiningDate: joinDate.toISOString() })).statusCode).toBe(200);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).acceptedAt).not.toBeNull();
    advanceClock(DAY);
    expect((await post(`/v1/recruitment/offers/${offer.id}/join`, "harsha", { joinedAt: now().toISOString() })).statusCode).toBe(200);
    expect(await stageOf(lead.id)).toBe("JOINED");
    const j = await prisma.joining.findFirstOrThrow({ where: { offerId: offer.id } });

    expect((await post(`/v1/recruitment/joinings/${j.id}/formalities`, "srividya")).statusCode).toBe(403);
    expect((await post(`/v1/recruitment/joinings/${j.id}/formalities`, "harsha")).json().message).toBe("Joining formalities marked complete");

    const url = `/v1/recruitment/joinings/${j.id}/retention`;
    expect((await post(url, "harsha", { day: 14, retained: "yes" })).json().error.message).toBe("Unknown checkpoint");
    expect((await post(url, "harsha", { day: 7, retained: "no" })).json().error.message).toBe("Give a reason for leaving");
    expect((await post(url, "harsha", { day: 7, retained: "yes" })).json().error.message).toMatch(/^Day-7 check is due on/);
    advanceClock(7 * DAY);
    expect((await post(url, "harsha", { day: 7, retained: "yes" })).json().message).toBe("Day-7 retention recorded");
    advanceClock(23 * DAY);
    expect((await post(url, "harsha", { day: 30, retained: "yes" })).json().message).toBe("Retained 30 days — lead is Successful");
    expect(await stageOf(lead.id)).toBe("SUCCESSFUL");
    const board = (await call({ method: "GET", url: "/v1/recruitment", as: "harsha" })).json();
    expect(board.outcomes[0]).toMatchObject({ toStage: "SUCCESSFUL", candidate: { id: lead.id } });
  });

  it("declining an offer drops the lead", async () => {
    const lead = await driveTo("SELECTED");
    await post("/v1/recruitment/offers", "sanjay", { submissionId: lead.submissionId });
    const offer = await prisma.offer.findFirstOrThrow({ where: { submissionId: lead.submissionId } });
    expect((await post(`/v1/recruitment/offers/${offer.id}/decline`, "srividya", { note: "x" })).statusCode).toBe(403);
    expect((await post(`/v1/recruitment/offers/${offer.id}/decline`, "sanjay", { note: "Counter-offer" })).json().message).toBe("Offer declined — lead dropped");
    expect(await stageOf(lead.id)).toBe("DROPPED");
  });
});
