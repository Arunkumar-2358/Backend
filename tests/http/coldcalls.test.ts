import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { advanceClock, setClock, DAY } from "@/lib/clock";
import { resetDb, userId } from "../helpers";
import { driveTo, orgId } from "../drive";
import { call } from "./client";

beforeEach(async () => {
  await resetDb();
  setClock(new Date("2026-06-01T05:00:00Z"));
});

describe("HTTP: cold-lead calls", () => {
  it("the leader allocates, the caller sees the number and logs the call; others are refused", async () => {
    const { id } = await driveTo("ACTIVE");
    advanceClock(61 * DAY);
    const sv = await userId("srividya");

    expect((await call({ method: "GET", url: "/v1/cold-calls", as: "jennifer" })).statusCode).toBe(403);
    const pool = (await call({ method: "GET", url: "/v1/cold-calls", as: "dixha" })).json();
    expect(pool.pool.leads.map((l: { id: string }) => l.id)).toEqual([id]);
    expect((await call({ method: "POST", url: "/v1/cold-calls/allocate", payload: { callerId: sv, ids: [id] }, as: "srividya" })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: "/v1/cold-calls/allocate", payload: { callerId: sv }, as: "dixha" })).statusCode).toBe(422);
    const ok = await call({ method: "POST", url: "/v1/cold-calls/allocate", payload: { callerId: sv, category: "NURSE", count: 5 }, as: "dixha" });
    expect(ok.json().message).toBe("1 cold lead allocated to Sri Vidya to call");

    // Amos has no call for this lead: no number for him.
    expect((await call({ method: "GET", url: `/v1/cold-calls/${id}/call`, as: "amos" })).statusCode).toBe(403);
    const contact = await call({ method: "GET", url: `/v1/cold-calls/${id}/call`, as: "srividya" });
    expect(contact.statusCode).toBe(200);
    expect(contact.json().mobile).toMatch(/^\d{10}$/);
    expect(await prisma.auditLog.count({ where: { action: "VIEW_PII", entityId: id } })).toBe(1);

    expect((await call({ method: "POST", url: `/v1/cold-calls/${id}/log`, payload: { outcome: "MAYBE" }, as: "srividya" })).statusCode).toBe(422);
    const logged = await call({ method: "POST", url: `/v1/cold-calls/${id}/log`, payload: { outcome: "UNANSWERED" }, as: "srividya" });
    expect(logged.json().message).toBe("No answer logged — it comes back as a recall");
    const done = await call({ method: "POST", url: `/v1/cold-calls/${id}/log`, payload: { outcome: "NEEDS_JOB", notes: "ICU" }, as: "srividya" });
    expect(done.json().message).toBe("Needs a job — lead is Super active");
    expect((await call({ method: "GET", url: "/v1/cold-calls", as: "srividya" })).json().total).toBe(0);
  });
});

describe("HTTP: daily dashboard", () => {
  it("a sourcer sees only their own month; leaders see anyone and the team, and can export", async () => {
    const sv = await userId("srividya");
    const own = (await call({ method: "GET", url: "/v1/kpi/daily?month=2026-06", as: "srividya" })).json();
    expect(own).toMatchObject({ sheet: "T2", month: "2026-06", prevMonth: "2026-05", nextMonth: "2026-07", subject: { id: sv, name: "Sri Vidya" }, seesAll: false, canExport: false });
    expect(own.members).toEqual([{ id: sv, name: "Sri Vidya" }]);
    expect(own.sheets).toEqual(["T2"]);
    expect(own.days).toHaveLength(30);
    // Asking for someone else still returns their own.
    const other = (await call({ method: "GET", url: `/v1/kpi/daily?user=${await userId("amos")}`, as: "srividya" })).json();
    expect(other.subject.id).toBe(sv);
    expect((await call({ method: "GET", url: "/v1/kpi/daily", as: "harsha" })).statusCode).toBe(403);

    const team = (await call({ method: "GET", url: "/v1/kpi/daily?sheet=T1A&month=2026-06", as: "sarala" })).json();
    expect(team).toMatchObject({ sheet: "T1A", subject: null, seesAll: true, canExport: true });
    expect(team.sheets).toEqual(["T1A", "T2"]);
    expect((await call({ method: "GET", url: "/v1/kpi/daily?sheet=T1A&user=nobody", as: "sarala" })).statusCode).toBe(422);

    expect((await call({ method: "GET", url: "/v1/kpi/daily/export?sheet=T2&month=2026-06", as: "srividya" })).statusCode).toBe(403);
    const xlsx = await call({ method: "GET", url: "/v1/kpi/daily/export?sheet=T2&month=2026-06", as: "dixha" });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    expect(xlsx.headers["content-disposition"]).toContain("TA-team-2-daily-dashboard-June-2026.xlsx");
  });
});

describe("HTTP: vacancy description, mandatory attributes and TA lead", () => {
  it("stores the free text and gives the posting to the category's Team 1a TA lead", async () => {
    const res = await call({
      method: "POST",
      url: "/v1/vacancies",
      payload: { clientOrgId: await orgId("GENERAL"), title: "Staff Nurse", category: "NURSE", location: "Hyderabad", description: "ICU staff nurse, rotational shifts", mandatoryAttributes: "Kukatpally · 1+ yr ICU · registration required · ₹18–20k/month" },
      as: "dixha",
    });
    expect(res.statusCode).toBe(200);
    const v = (await call({ method: "GET", url: `/v1/vacancies/${res.json().id}`, as: "jennifer" })).json();
    expect(v.vacancy).toMatchObject({ description: "ICU staff nurse, rotational shifts", mandatoryAttributes: "Kukatpally · 1+ yr ICU · registration required · ₹18–20k/month", taLead: { name: "Jennifer" } });
    // Team 1 can read postings but not create them.
    const full = { clientOrgId: await orgId("GENERAL"), title: "Staff Nurse", category: "NURSE", location: "Hyderabad" };
    expect((await call({ method: "POST", url: "/v1/vacancies", payload: full, as: "jennifer" })).statusCode).toBe(403);
    const mine = (await call({ method: "GET", url: "/v1/vacancies?mine=1", as: "jennifer" })).json();
    expect(mine.total).toBe(1);
  });
});
