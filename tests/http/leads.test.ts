import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { SYSTEM } from "@/lib/rbac";
import { createCandidate, type CandidateInput } from "@/modules/candidates/service";
import { transitionLead } from "@/modules/lifecycle/transition";
import { createTask } from "@/modules/tasks/service";
import { resetDb, userId, completeProfile, nextMobile } from "../helpers";
import { makeVacancy } from "../drive";
import { allowedTargets } from "@contracts/shared/lifecycle";
import { call } from "./client";

beforeEach(resetDb);

/** A lead owned by a seeded user (MAPPING unless moved on). */
async function leadOwnedBy(key: string | null, overrides: CandidateInput = {}) {
  return createCandidate(SYSTEM("test"), completeProfile(overrides), { ownerUserId: key ? await userId(key) : null });
}
async function validatedLeadOf(key: string, overrides: CandidateInput = {}) {
  const lead = await leadOwnedBy(key, overrides);
  await transitionLead(SYSTEM("test"), lead.id, "VALIDATED");
  return lead;
}

describe("HTTP: GET /v1/leads", () => {
  it("lists only leads in the caller's scope, with masked mobiles and no encrypted columns", async () => {
    const mine = await leadOwnedBy("jennifer", { name: "Mine Lead" });
    await leadOwnedBy("poojitha", { name: "Not Mine" });

    const admin = (await call({ method: "GET", url: "/v1/leads", as: "admin" })).json();
    expect(admin.list.total).toBe(2);
    expect(admin.board).toBeNull();

    const res = await call({ method: "GET", url: "/v1/leads", as: "jennifer" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.list.total).toBe(1);
    expect(body.list.rows[0].id).toBe(mine.id);
    expect(body.list.rows[0].mobileMasked).toMatch(/\d{4}$/);
    expect(body.list.rows[0].mobileMasked).not.toMatch(/^\d{10}$/);
    expect(body.list.rows[0]).not.toHaveProperty("mobileEnc");
    expect(body.owners.map((o: { name: string }) => o.name).sort()).toEqual(["Jennifer", "Poojitha"]);
  });

  it("applies filters (owner, search, stage) and builds the kanban board", async () => {
    await leadOwnedBy("jennifer", { name: "Asha One" });
    await validatedLeadOf("jennifer", { name: "Bina Two" });
    await leadOwnedBy(null, { name: "Chandra Three" });

    const q = async (qs: string) => (await call({ method: "GET", url: `/v1/leads?${qs}`, as: "admin" })).json();
    expect((await q("owner=none")).list.total).toBe(1);
    expect((await q("owner=me")).list.total).toBe(0);
    expect((await q("q=bina")).list.rows.map((r: { name: string }) => r.name)).toEqual(["Bina Two"]);
    expect((await q("stage=VALIDATED")).list.total).toBe(1);

    const board = (await q("view=kanban&stage=VALIDATED")).board;
    expect(board.counts).toEqual({ MAPPING: 2, VALIDATED: 1 });
    expect(board.columns.MAPPING).toHaveLength(2);
    expect(board.columns.SUCCESSFUL).toEqual([]);
  });

  it("rejects an unknown stage filter", async () => {
    expect((await call({ method: "GET", url: "/v1/leads?stage=BOGUS", as: "admin" })).statusCode).toBe(422);
  });
});

describe("HTTP: POST /v1/leads", () => {
  it("creates a lead owned by the caller and passes the Mapping gate when complete", async () => {
    const mobile = nextMobile();
    const res = await call({
      method: "POST",
      url: "/v1/leads",
      as: "jennifer",
      payload: { name: "New Nurse", mobile, mainCategory: "NURSE", jobTitle: "Staff Nurse", currentLocation: "Hyderabad", source: "REFERRAL", consent: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gate).toBeNull();
    expect(body.visible).toBe(true);
    const lead = await prisma.candidate.findUniqueOrThrow({ where: { id: body.id } });
    expect(lead.stage).toBe("VALIDATED");
    expect(lead.ownerUserId).toBe(await userId("jennifer"));
    expect(lead.consentRecordStoreShare).toBe(true);
  });

  it("keeps an incomplete lead in Mapping and reports the gate", async () => {
    const body = (await call({ method: "POST", url: "/v1/leads", as: "jennifer", payload: { name: "Thin Lead", mobile: nextMobile() } })).json();
    expect(body.gate).toContain("Job category not assigned");
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: body.id } })).stage).toBe("MAPPING");
  });

  it("validates input", async () => {
    const post = (payload: object) => call({ method: "POST", url: "/v1/leads", as: "jennifer", payload });
    const noName = await post({ mobile: nextMobile() });
    expect(noName.statusCode).toBe(422);
    expect(noName.json().error.message).toBe("Name is required");
    expect((await post({ name: "X" })).json().error.message).toBe("Mobile is required");
    expect((await post({ name: "X", mobile: nextMobile(), source: "MARS" })).json().error.message).toBe("Unknown source");
    expect((await post({ name: "X", mobile: nextMobile(), mainCategory: "ALIEN" })).json().error.message).toBe("Unknown category");
    const m = nextMobile();
    await post({ name: "First", mobile: m });
    expect((await post({ name: "Second", mobile: m })).statusCode).toBe(422);
  });
});

describe("HTTP: GET /v1/leads/{id}", () => {
  it("returns the decrypted lead and records a PII view", async () => {
    const lead = await validatedLeadOf("jennifer", { email: "detail@example.com" });
    const res = await call({ method: "GET", url: `/v1/leads/${lead.id}`, as: "jennifer" });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.lead.email).toBe("detail@example.com");
    expect(d.lead.mobile).toMatch(/^\d{10}$/);
    expect(d.lead).not.toHaveProperty("mobileEnc");
    expect(d.lead).not.toHaveProperty("emailHash");
    expect(d.lead.owner.name).toBe("Jennifer");
    expect(d.can).toMatchObject({ edit: true, stageLeader: false, viewAudit: false, admin: false, stagePanel: true, logContact: true });
    expect(d.transitions.map((t: { to: string }) => t.to)).toEqual(allowedTargets("VALIDATED"));
    expect(d.transitions[0].description).toMatch(/ENROLLED/);
    expect(d.history.length).toBe(2);
    expect(d.tasks.length).toBe(1);
    expect(d.audits).toEqual([]);
    expect(d.deletionRequests).toEqual([]);
    expect(d.members).toEqual([]);
    expect(d.fileLimits.resumeBytes).toBeGreaterThan(0);
    expect(await prisma.auditLog.count({ where: { action: "VIEW_PII", entityId: lead.id, actorId: await userId("jennifer") } })).toBe(1);
  });

  it("gives admins and stage leaders their extra panels", async () => {
    const lead = await validatedLeadOf("jennifer");
    const admin = (await call({ method: "GET", url: `/v1/leads/${lead.id}`, as: "admin" })).json();
    expect(admin.can.admin).toBe(true);
    expect(admin.audits.length).toBeGreaterThan(0);
    const sarala = (await call({ method: "GET", url: `/v1/leads/${lead.id}`, as: "sarala" })).json();
    expect(sarala.can.stageLeader).toBe(true);
    expect(sarala.members.map((m: { name: string }) => m.name)).toContain("Jennifer");
    expect(sarala.members[0]).not.toHaveProperty("passwordHash");
  });

  it("403s a lead outside the caller's scope (no PII view logged) and 404s a missing one", async () => {
    const lead = await leadOwnedBy("poojitha");
    const res = await call({ method: "GET", url: `/v1/leads/${lead.id}`, as: "jennifer" });
    expect(res.statusCode).toBe(403);
    expect(await prisma.auditLog.count({ where: { action: "VIEW_PII", entityId: lead.id } })).toBe(0);
    expect((await call({ method: "GET", url: "/v1/leads/nope", as: "jennifer" })).statusCode).toBe(404);
  });
});

describe("HTTP: lead commands", () => {
  it("transitions a lead, refusing unavailable stages and invisible leads", async () => {
    const lead = await leadOwnedBy("greeshma", { name: "Mapped" });
    const bad = await call({ method: "POST", url: `/v1/leads/${lead.id}/transition`, as: "greeshma", payload: { to: "JOINED" } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toBe("That stage change is not available from here");
    const badReason = await call({ method: "POST", url: `/v1/leads/${lead.id}/transition`, as: "greeshma", payload: { to: "INVALID", dropReason: "NOPE", note: "x" } });
    expect(badReason.statusCode).toBe(422);

    expect((await call({ method: "POST", url: `/v1/leads/${lead.id}/transition`, as: "jennifer", payload: { to: "VALIDATED" } })).statusCode).toBe(403);

    const ok = await call({ method: "POST", url: `/v1/leads/${lead.id}/transition`, as: "greeshma", payload: { to: "VALIDATED", note: "Checked" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().message).toBe("Moved to Validated");
  });

  it("reports gate failures as 422 GATE", async () => {
    const lead = await validatedLeadOf("jennifer");
    const res = await call({ method: "POST", url: `/v1/leads/${lead.id}/transition`, as: "jennifer", payload: { to: "ENROLLED" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("GATE");
    expect(res.json().error.failures).toEqual(["No contact attempt with outcome ENROLLED has been logged"]);
  });

  it("saves the profile for the owner only, converting and validating fields", async () => {
    const lead = await validatedLeadOf("jennifer");
    const current = (await call({ method: "GET", url: `/v1/leads/${lead.id}`, as: "jennifer" })).json().lead;
    const form = {
      name: "Renamed",
      mobile: current.mobile,
      email: current.email,
      experienceYears: "7.5",
      preferredLocations: ["Pune", "Goa"],
      consentRecordStoreShare: true,
      source: "",
    };
    const put = (as: string, payload: object) => call({ method: "PUT", url: `/v1/leads/${lead.id}/profile`, as, payload });
    const ok = await put("jennifer", form);
    expect(ok.statusCode).toBe(200);
    const after = await prisma.candidate.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after).toMatchObject({ name: "Renamed", experienceYears: 7.5, preferredLocations: ["Pune", "Goa"], source: lead.source, jobTitle: null });

    expect((await put("jennifer", { ...form, name: "" })).json().error.message).toBe("Name is required");
    expect((await put("jennifer", { ...form, noticePeriodDays: "1.5" })).json().error.message).toBe("Notice period (days) must be a whole number");
    expect((await put("jennifer", { ...form, name: { evil: true } })).statusCode).toBe(422);

    // Visible through an open task, but not editable.
    await createTask(SYSTEM("test"), { type: "GENERAL", title: "Help", candidateId: lead.id, assigneeId: await userId("bhavani"), dueAt: new Date(), notify: false });
    expect((await put("bhavani", form)).statusCode).toBe(403);
    expect((await put("poojitha", form)).statusCode).toBe(403);
  });

  it("logs contact and sends the enrolment link", async () => {
    const lead = await validatedLeadOf("jennifer");
    const url = `/v1/leads/${lead.id}/contacts`;
    const ok = await call({ method: "POST", url, as: "jennifer", payload: { channel: "CALL", outcome: "UNANSWERED", notes: "No answer", nextFollowupAt: "2030-01-01T10:00" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().message).toBe("Contact logged");
    const attempt = await prisma.contactAttempt.findFirstOrThrow({ where: { candidateId: lead.id } });
    expect(attempt.nextFollowupAt?.toISOString()).toBe("2030-01-01T04:30:00.000Z");

    expect((await call({ method: "POST", url, as: "jennifer", payload: { channel: "PIGEON", outcome: "UNANSWERED" } })).json().error.message).toBe("Pick a channel");
    expect((await call({ method: "POST", url, as: "jennifer", payload: { channel: "CALL" } })).json().error.message).toBe("Pick an outcome");
    expect((await call({ method: "POST", url, as: "jennifer", payload: { channel: "CALL", outcome: "UNANSWERED", nextFollowupAt: "soon" } })).json().error.message).toBe("Invalid follow-up date");
    expect((await call({ method: "POST", url, as: "poojitha", payload: { channel: "CALL", outcome: "UNANSWERED" } })).statusCode).toBe(403);

    const enrolled = await call({ method: "POST", url, as: "jennifer", payload: { channel: "CALL", outcome: "ENROLLED" } });
    expect(enrolled.json().message).toBe("Contact logged — lead moved to Enrolled");

    const other = await validatedLeadOf("jennifer");
    const link = await call({ method: "POST", url: `/v1/leads/${other.id}/enrolment-link`, as: "jennifer", payload: { channel: "WHATSAPP" } });
    expect(link.statusCode).toBe(200);
    expect(link.json().message).toBe("Enrolment link sent by WhatsApp");
    expect((await call({ method: "POST", url: `/v1/leads/${other.id}/enrolment-link`, as: "jennifer", payload: { channel: "CALL" } })).statusCode).toBe(422);
    expect((await call({ method: "POST", url: `/v1/leads/${other.id}/enrolment-link`, as: "poojitha", payload: { channel: "SMS" } })).statusCode).toBe(403);
  });

  it("lets only the stage leader reassign, within the owning team", async () => {
    const lead = await validatedLeadOf("jennifer");
    const url = `/v1/leads/${lead.id}/reassign`;
    const bhavani = await userId("bhavani");
    expect((await call({ method: "POST", url, as: "jennifer", payload: { toUserId: bhavani } })).statusCode).toBe(403);
    const outsider = await call({ method: "POST", url, as: "sarala", payload: { toUserId: await userId("harsha") } });
    expect(outsider.statusCode).toBe(422);
    expect(outsider.json().error.message).toBe("That person is not in the team that owns this stage");
    expect((await call({ method: "POST", url, as: "sarala", payload: {} })).json().error.message).toBe("Pick a team member");
    expect((await call({ method: "POST", url, as: "sarala", payload: { toUserId: await userId("jennifer") } })).json().message).toBe("Jennifer already owns this lead");
    const ok = await call({ method: "POST", url, as: "sarala", payload: { toUserId: bhavani } });
    expect(ok.json().message).toBe("Reassigned to Bhavani");
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: lead.id } })).ownerUserId).toBe(bhavani);
  });

  it("records a data-deletion request for admins only, once", async () => {
    const lead = await leadOwnedBy("jennifer");
    const url = `/v1/leads/${lead.id}/deletion-requests`;
    expect((await call({ method: "POST", url, as: "jennifer", payload: { requestedVia: "Email" } })).statusCode).toBe(403);
    const ok = await call({ method: "POST", url, as: "admin", payload: { requestedVia: "Email", reason: "Asked by phone" } });
    expect(ok.statusCode).toBe(200);
    const again = await call({ method: "POST", url, as: "admin", payload: {} });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe("A deletion request for this candidate is already pending");
    const d = (await call({ method: "GET", url: `/v1/leads/${lead.id}`, as: "admin" })).json();
    expect(d.deletionRequests).toHaveLength(1);
  });
});

describe("HTTP: GET /v1/search", () => {
  it("returns null for an empty query", async () => {
    expect((await call({ method: "GET", url: "/v1/search?q=%20", as: "jennifer" })).json()).toEqual({ result: null });
  });

  it("scopes leads and only searches vacancies / people for roles that may see them", async () => {
    await leadOwnedBy("jennifer", { name: "Hyder One", currentLocation: "Hyderabad" });
    await leadOwnedBy("poojitha", { name: "Hyder Two", currentLocation: "Hyderabad" });
    await makeVacancy({ title: "Staff Nurse – ICU", location: "Hyderabad" });

    const j = (await call({ method: "GET", url: "/v1/search?q=hyderabad", as: "jennifer" })).json().result;
    expect(j.leadCount).toBe(1);
    expect(j.leads[0].mobileMasked).toMatch(/\d{4}$/);
    expect(j.leads[0]).not.toHaveProperty("mobileEnc");
    expect(j.vacancyCount).toBe(0);
    expect(j.people).toEqual([]);

    const coord = (await call({ method: "GET", url: "/v1/search?q=hyderabad", as: "sumitha" })).json().result;
    expect(coord.leadCount).toBe(2);
    expect(coord.vacancies.map((v: { title: string }) => v.title)).toEqual(["Staff Nurse – ICU"]);
    expect(coord.vacancies[0]._count.submissions).toBe(0);

    const people = (await call({ method: "GET", url: "/v1/search?q=jennifer", as: "admin" })).json().result.people;
    expect(people.map((p: { name: string }) => p.name)).toEqual(["Jennifer"]);
    expect(people[0]).not.toHaveProperty("passwordHash");
    expect(people[0].roles[0].team.name).toBeTruthy();
    expect((await call({ method: "GET", url: "/v1/search?q=jennifer", as: "harsha" })).json().result.people).toEqual([]);
  });
});
