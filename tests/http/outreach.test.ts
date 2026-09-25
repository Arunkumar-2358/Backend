import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { now, HOUR } from "@/lib/clock";
import { logMissedCall } from "@/modules/outreach/service";
import { resetDb, as, nextMobile, stageOf, userId } from "../helpers";
import { driveTo } from "../drive";
import { call } from "./client";

beforeEach(resetDb);

const piiViews = (entityId: string) => prisma.auditLog.count({ where: { action: "VIEW_PII", entityId } });

describe("HTTP: outreach queue", () => {
  it("lists the caller's own Validated leads without PII and with the attempt cap", async () => {
    const { id } = await driveTo("VALIDATED"); // NURSE → owned by jennifer
    const res = await call({ method: "GET", url: "/v1/queue", as: "jennifer" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe("mine");
    expect(body.cap).toBe(5);
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual([id]);
    expect(body.rows[0].hasEmail).toBe(true);
    expect(body.rows[0]).not.toHaveProperty("mobileEnc");
    expect(body.rows[0]).not.toHaveProperty("emailEnc");
    expect((await call({ method: "GET", url: "/v1/queue", as: "poojitha" })).json().total).toBe(0);
  });

  it("gives team scope and tele-callers only to the Team 1 leader", async () => {
    await driveTo("VALIDATED");
    const agent = (await call({ method: "GET", url: "/v1/queue?scope=team", as: "jennifer" })).json();
    expect(agent.scope).toBe("mine");
    const leader = (await call({ method: "GET", url: "/v1/queue?scope=team&overdue=0", as: "sarala" })).json();
    expect(leader.scope).toBe("team");
    expect(leader.total).toBe(1);
    expect(leader.telecallers.length).toBeGreaterThan(0);
  });

  it("refuses the queue to other teams and rejects a bad scope", async () => {
    expect((await call({ method: "GET", url: "/v1/queue", as: "srividya" })).statusCode).toBe(403);
    expect((await call({ method: "GET", url: "/v1/queue?scope=everyone", as: "jennifer" })).statusCode).toBe(422);
  });

  it("reveals contact details to the owner only, and logs the PII view", async () => {
    const { id } = await driveTo("VALIDATED");
    expect((await call({ method: "GET", url: `/v1/queue/${id}/call`, as: "bhavani" })).statusCode).toBe(403);
    expect(await piiViews(id)).toBe(0);
    const res = await call({ method: "GET", url: `/v1/queue/${id}/call`, as: "jennifer" });
    expect(res.statusCode).toBe(200);
    expect(res.json().mobile).toMatch(/^\d{10}$/);
    expect(await piiViews(id)).toBe(1);
    expect((await call({ method: "GET", url: `/v1/queue/nope/call`, as: "jennifer" })).statusCode).toBe(404);
  });

  it("logs a contact and reports the stage move", async () => {
    const { id } = await driveTo("VALIDATED");
    const bb = await call({ method: "POST", url: `/v1/queue/${id}/contact`, as: "jennifer", payload: { channel: "CALL", outcome: "UNANSWERED" } });
    expect(bb.statusCode).toBe(200);
    expect(bb.json().message).toBe("Unanswered logged — next follow-up scheduled");
    const en = await call({ method: "POST", url: `/v1/queue/${id}/contact`, as: "jennifer", payload: { channel: "CALL", outcome: "ENROLLED", notes: " " } });
    expect(en.json().message).toBe("Enrolled logged — lead moved to Enrolled");
    expect(await stageOf(id)).toBe("ENROLLED");
  });

  it("refuses contact on someone else's lead and rejects a bad outcome", async () => {
    const { id } = await driveTo("VALIDATED");
    expect((await call({ method: "POST", url: `/v1/queue/${id}/contact`, as: "poojitha", payload: { channel: "CALL", outcome: "UNANSWERED" } })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: `/v1/queue/${id}/contact`, as: "jennifer", payload: { channel: "CALL", outcome: "ANSWERED" } })).statusCode).toBe(422);
  });

  it("sends the enrolment link", async () => {
    const { id } = await driveTo("VALIDATED");
    const res = await call({ method: "POST", url: `/v1/queue/${id}/enrolment-link`, as: "jennifer", payload: { channel: "WHATSAPP" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe("Enrolment link sent by WhatsApp (logged as Bb)");
    expect((await call({ method: "POST", url: `/v1/queue/${id}/enrolment-link`, as: "jennifer", payload: { channel: "CALL" } })).statusCode).toBe(422);
  });

  it("lets only the Team 1 leader allocate first-time calls", async () => {
    const { id } = await driveTo("VALIDATED");
    const bhavani = await userId("bhavani");
    expect((await call({ method: "POST", url: "/v1/queue/allocate", as: "jennifer", payload: { ids: [id], telecallerId: bhavani } })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: "/v1/queue/allocate", as: "sarala", payload: { ids: [], telecallerId: bhavani } })).json().error.message).toBe("Tick at least one lead to allocate");
    const ok = await call({ method: "POST", url: "/v1/queue/allocate", as: "sarala", payload: { ids: [id], telecallerId: bhavani } });
    expect(ok.json().message).toBe("1 lead allocated for first-time verified calls");
    const queue = (await call({ method: "GET", url: "/v1/queue", as: "bhavani" })).json();
    expect(queue.rows[0].firstCall).toBe(true);
  });

  it("adds a portal lead for TA leads only", async () => {
    const payload = { name: "Ravi", mobile: nextMobile(), source: "NAUKRI", mainCategory: "NURSE", currentLocation: "Hyderabad", jobTitle: "Staff nurse" };
    expect((await call({ method: "POST", url: "/v1/queue/portal-leads", as: "bhavani", payload })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: "/v1/queue/portal-leads", as: "jennifer", payload: { ...payload, source: "NT" } })).statusCode).toBe(422);
    const res = await call({ method: "POST", url: "/v1/queue/portal-leads", as: "jennifer", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toMatch(/^Lead NTC\d+ added to your queue \(Validated\)$/);
    const gated = await call({ method: "POST", url: "/v1/queue/portal-leads", as: "jennifer", payload: { name: "Sita", mobile: nextMobile(), source: "LINKEDIN" } });
    expect(gated.json().message).toMatch(/went to Mapping/);
  });
});

describe("HTTP: missed-call inbox", () => {
  it("logs a missed call and lists it for the assignee with the week's funnel", async () => {
    const res = await call({ method: "POST", url: "/v1/missed-calls", as: "bhavani", payload: { mobile: "8000000001", notes: "rang twice" } });
    expect(res.statusCode).toBe(200);
    const inbox = (await call({ method: "GET", url: "/v1/missed-calls", as: "bhavani" })).json();
    expect(inbox.openCount).toBe(1);
    expect(inbox.funnel.missed).toBe(1);
    expect(inbox.calls[0].fromLast4).toBe("0001");
    expect(inbox.calls[0]).not.toHaveProperty("fromMobileEnc");
    expect(inbox.calls[0].recallDue).toBeTruthy();
    expect((await call({ method: "GET", url: "/v1/missed-calls", as: "punitha" })).json().openCount).toBe(0);
    expect((await call({ method: "GET", url: "/v1/missed-calls", as: "sarala" })).json().calls[0].assigneeName).toBe("Bhavani");
  });

  it("refuses the inbox and logging outside Team 1b, and validates input", async () => {
    expect((await call({ method: "GET", url: "/v1/missed-calls", as: "jennifer" })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: "/v1/missed-calls", as: "jennifer", payload: { mobile: "8000000001" } })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: "/v1/missed-calls", as: "bhavani", payload: { mobile: "" } })).json().error.message).toBe("Enter the caller's number");
    const future = new Date(now().getTime() + 2 * HOUR).toISOString();
    expect((await call({ method: "POST", url: "/v1/missed-calls", as: "bhavani", payload: { mobile: "8000000001", receivedAt: future } })).json().error.message).toBe("Received time is in the future");
  });

  it("reveals the caller number to the assignee only, auditing the view", async () => {
    const mc = await logMissedCall(await as("bhavani"), { mobile: "8000000002" });
    expect((await call({ method: "GET", url: `/v1/missed-calls/${mc.id}/call`, as: "punitha" })).statusCode).toBe(403);
    const res = await call({ method: "GET", url: `/v1/missed-calls/${mc.id}/call`, as: "bhavani" });
    expect(res.statusCode).toBe(200);
    expect(res.json().mobile).toBe("8000000002");
    expect(res.json().lead).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "VIEW_PII", entityType: "missed_call", entityId: mc.id } })).toBe(1);
  });

  it("records a recall, creating a lead for an unknown caller", async () => {
    const mc = await logMissedCall(await as("bhavani"), { mobile: "8000000003" });
    expect((await call({ method: "POST", url: `/v1/missed-calls/${mc.id}/recall`, as: "punitha", payload: { answered: true } })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: `/v1/missed-calls/${mc.id}/recall`, as: "bhavani", payload: { enrolled: true } })).json().error.message).toBe("Tick 'Answered' or 'Link sent' before marking the caller enrolled");
    expect((await call({ method: "POST", url: `/v1/missed-calls/${mc.id}/recall`, as: "bhavani", payload: { name: "Kiran" } })).json().error.message).toBe("A new lead can only be created when the caller answered");
    const res = await call({
      method: "POST",
      url: `/v1/missed-calls/${mc.id}/recall`,
      as: "bhavani",
      payload: { answered: true, name: "Kiran", mainCategory: "PHARMACY", currentLocation: "Chennai", jobTitle: "Pharmacist" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toMatch(/^Recall saved: answered, lead NTC\d+ created · closed$/);
    expect((await call({ method: "POST", url: `/v1/missed-calls/${mc.id}/recall`, as: "bhavani", payload: { answered: true } })).json().error.message).toBe("This missed call is already closed");
  });
});

describe("HTTP: availability check-ins", () => {
  it("scopes qualified leads to the owner and shows everything to the Team 2 leader", async () => {
    const { id } = await driveTo("QUALIFIED"); // NURSE → owned by srividya
    const own = (await call({ method: "GET", url: "/v1/availability", as: "srividya" })).json();
    expect(own.isLeader).toBe(false);
    expect(own.qualified.map((c: { id: string }) => c.id)).toEqual([id]);
    expect((await call({ method: "GET", url: "/v1/availability?cold=1", as: "srividya" })).json().qualified).toHaveLength(0);
    expect((await call({ method: "GET", url: "/v1/availability", as: "amos" })).json().qualifiedTotal).toBe(0);
    expect((await call({ method: "GET", url: "/v1/availability", as: "dixha" })).json().qualifiedTotal).toBe(1);
  });

  it("records check-ins for Team 2 only and flags cold / warm", async () => {
    const { id } = await driveTo("QUALIFIED");
    expect((await call({ method: "POST", url: `/v1/availability/${id}/check`, as: "jennifer", payload: { available: false } })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: `/v1/availability/${id}/check`, as: "srividya", payload: { available: "maybe" } })).statusCode).toBe(422);
    const no = await call({ method: "POST", url: `/v1/availability/${id}/check`, as: "srividya", payload: { available: false, notes: "Abroad" } });
    expect(no.json().message).toBe("Recorded as not available — lead flagged cold; next check-in scheduled");
    const view = (await call({ method: "GET", url: "/v1/availability", as: "srividya" })).json();
    expect(view.coldCount).toBe(1);
    expect(view.qualified[0].nextCheckAt).toBeTruthy();
    expect(view.qualified[0].lastCheck.notes).toBe("Abroad");

    expect((await call({ method: "POST", url: `/v1/availability/${id}/cold`, as: "jennifer", payload: { cold: false } })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: `/v1/availability/${id}/cold`, as: "srividya", payload: { cold: false } })).json().message).toBe("Flagged warm");

    const yes = await call({ method: "POST", url: `/v1/availability/${id}/check`, as: "srividya", payload: { available: true } });
    expect(yes.json().message).toBe("Availability confirmed — lead moved to Active");
    expect(await stageOf(id)).toBe("ACTIVE");
  });
});

describe("HTTP: enrolment scrutiny", () => {
  it("lists enrolled leads by completeness tab, scoped to the owner", async () => {
    const { id } = await driveTo("ENROLLED"); // complete profile, owned by srividya
    const own = (await call({ method: "GET", url: "/v1/scrutiny?tab=complete", as: "srividya" })).json();
    expect(own.counts).toEqual({ incomplete: 0, complete: 1, all: 1 });
    expect(own.leads[0].id).toBe(id);
    expect(own.leads[0].missing).toEqual([]);
    expect(own.leads[0].pct).toBe(100);
    expect(own.leads[0]).not.toHaveProperty("mobile");
    expect((await call({ method: "GET", url: "/v1/scrutiny?tab=all", as: "amos" })).json().total).toBe(0);
    expect((await call({ method: "GET", url: "/v1/scrutiny?tab=bogus", as: "srividya" })).statusCode).toBe(422);
  });

  it("scrutinises for Team 2 and lets only the leader verify", async () => {
    const { id } = await driveTo("ENROLLED");
    expect((await call({ method: "POST", url: `/v1/scrutiny/${id}/scrutinize`, as: "jennifer", payload: {} })).statusCode).toBe(403);
    const ok = await call({ method: "POST", url: `/v1/scrutiny/${id}/scrutinize`, as: "srividya", payload: { remark: "Looks good" } });
    expect(ok.json().message).toBe("Scrutinised — profile complete, awaiting team leader verification");
    expect((await call({ method: "POST", url: `/v1/scrutiny/${id}/verify`, as: "srividya", payload: {} })).statusCode).toBe(403);
    const v = await call({ method: "POST", url: `/v1/scrutiny/${id}/verify`, as: "dixha", payload: { tlRemark: "Verified" } });
    expect(v.json().message).toBe("Verified — lead moved to Qualified");
    expect(await stageOf(id)).toBe("QUALIFIED");
  });
});
