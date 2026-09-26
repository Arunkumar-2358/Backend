import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { SYSTEM } from "@/lib/rbac";
import { requestDataDeletion } from "@/modules/candidates/service";
import { DEV_PASSWORD, emailFor } from "@/modules/seed/core";
import { newLead, resetDb, userId } from "../helpers";
import { call } from "./client";

beforeEach(resetDb);

const audits = (entityType: string) => prisma.auditLog.findMany({ where: { entityType }, orderBy: { at: "asc" } });

describe("HTTP: admin access", () => {
  const reads = ["/v1/admin/users", "/v1/admin/rules", "/v1/admin/templates", "/v1/admin/settings", "/v1/admin/holidays", "/v1/admin/targets", "/v1/admin/attendance", "/v1/admin/deletions", "/v1/admin/audit", "/v1/admin/jobs"];

  it("refuses every admin read to non-admins, including leaders", async () => {
    for (const url of reads) {
      expect((await call({ method: "GET", url, as: "sarala" })).statusCode, url).toBe(403);
      expect((await call({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });

  it("refuses every admin command to non-admins", async () => {
    const cmds: { method: "POST" | "PUT" | "DELETE"; url: string; payload?: object }[] = [
      { method: "POST", url: "/v1/admin/users", payload: { name: "X", email: "x@example.com", password: "password1" } },
      { method: "POST", url: "/v1/admin/users/abc/grants", payload: { team: "T1A", role: "ta_lead" } },
      { method: "DELETE", url: "/v1/admin/grants/abc" },
      { method: "POST", url: "/v1/admin/users/abc/active", payload: { active: false } },
      { method: "POST", url: "/v1/admin/users/abc/password", payload: { password: "password1" } },
      { method: "POST", url: "/v1/admin/rules", payload: { teamCode: "T1A", userId: "abc", active: true } },
      { method: "DELETE", url: "/v1/admin/rules/abc" },
      { method: "POST", url: "/v1/admin/templates", payload: { key: "k", name: "n", channel: "SMS", body: "b", active: true } },
      { method: "PUT", url: "/v1/admin/settings", payload: { fields: {} } },
      { method: "POST", url: "/v1/admin/holidays", payload: { date: "2026-10-20", name: "Diwali" } },
      { method: "DELETE", url: "/v1/admin/holidays/abc" },
      { method: "POST", url: "/v1/admin/targets", payload: { metricKey: "x" } },
      { method: "DELETE", url: "/v1/admin/targets/abc" },
      { method: "PUT", url: "/v1/admin/attendance", payload: { users: [], days: [], present: [] } },
      { method: "POST", url: "/v1/admin/deletions/abc/process" },
      { method: "POST", url: "/v1/admin/deletions/abc/reject", payload: {} },
      { method: "POST", url: "/v1/admin/jobs/run" },
      { method: "POST", url: "/v1/admin/kpi/freeze" },
    ];
    for (const c of cmds) {
      const res = await call({ ...c, as: "jennifer" });
      expect(res.statusCode, c.url).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    }
  });
});

describe("HTTP: admin users & roles", () => {
  it("lists users without password hashes", async () => {
    const res = await call({ method: "GET", url: "/v1/admin/users", as: "admin" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.teams.length).toBe(7);
    const jen = body.users.find((u: { email: string }) => u.email === emailFor("jennifer"));
    expect(jen.roles[0].team.code).toBe("T1A");
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("creates a user with a first grant, and validates input", async () => {
    const bad = await call({ method: "POST", url: "/v1/admin/users", payload: { name: "New", email: "nope", password: "password1" }, as: "admin" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toBe("Enter a valid email");
    const short = await call({ method: "POST", url: "/v1/admin/users", payload: { name: "New", email: "new@example.com", password: "short" }, as: "admin" });
    expect(short.json().error.message).toBe("Temporary password must be at least 8 characters");
    const noRole = await call({ method: "POST", url: "/v1/admin/users", payload: { name: "New", email: "new@example.com", password: "password1", team: "T2" }, as: "admin" });
    expect(noRole.json().error.message).toBe("Choose a role");
    expect((await call({ method: "POST", url: "/v1/admin/users", payload: { name: "New", email: "new@example.com", password: "password1", team: "BOGUS" }, as: "admin" })).statusCode).toBe(422);

    const ok = await call({ method: "POST", url: "/v1/admin/users", payload: { name: "New Person", email: "New@Example.com", password: "password1", team: "T2", role: "sourcer", category: "NURSE" }, as: "admin" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().message).toBe("User New Person created");
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "new@example.com" }, include: { roles: true } });
    expect(u.roles).toMatchObject([{ role: "sourcer", category: "NURSE" }]);
    expect((await audits("user")).map((a) => a.action)).toEqual(["CREATE"]);

    const dup = await call({ method: "POST", url: "/v1/admin/users", payload: { name: "Again", email: "new@example.com", password: "password1" }, as: "admin" });
    expect(dup.json().error.message).toBe("A user with new@example.com already exists");
  });

  it("adds and removes grants, protecting the last admin", async () => {
    const jen = await userId("jennifer");
    const add = await call({ method: "POST", url: `/v1/admin/users/${jen}/grants`, payload: { team: "T1B", role: "telecaller" }, as: "admin" });
    expect(add.json().message).toBe("Grant saved — takes effect on the user's next request");
    const grant = await prisma.userTeamRole.findFirstOrThrow({ where: { userId: jen, role: "telecaller" } });
    expect((await call({ method: "DELETE", url: `/v1/admin/grants/${grant.id}`, as: "admin" })).json().message).toBe("Grant removed");

    const adminGrant = await prisma.userTeamRole.findFirstOrThrow({ where: { userId: await userId("admin"), role: "admin" } });
    const last = await call({ method: "DELETE", url: `/v1/admin/grants/${adminGrant.id}`, as: "admin" });
    expect(last.statusCode).toBe(422);
    expect(last.json().error.message).toBe("You are the only active admin — add another admin first");
    expect((await call({ method: "POST", url: `/v1/admin/users/${jen}/grants`, payload: {}, as: "admin" })).json().error.message).toBe("Choose a team");
  });

  it("activates, deactivates and resets passwords", async () => {
    const jen = await userId("jennifer");
    expect((await call({ method: "POST", url: `/v1/admin/users/${jen}/active`, payload: { active: false }, as: "admin" })).json().message).toBe("User deactivated — they are signed out on their next request");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: jen } })).active).toBe(false);
    const self = await call({ method: "POST", url: `/v1/admin/users/${await userId("admin")}/active`, payload: { active: false }, as: "admin" });
    expect(self.json().error.message).toBe("You cannot deactivate yourself");
    expect((await call({ method: "POST", url: `/v1/admin/users/${jen}/active`, payload: {}, as: "admin" })).statusCode).toBe(422);

    const before = (await prisma.user.findUniqueOrThrow({ where: { id: jen } })).passwordHash;
    expect((await call({ method: "POST", url: `/v1/admin/users/${jen}/password`, payload: { password: "newpassword" }, as: "admin" })).json().message).toBe("Temporary password set");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: jen } })).passwordHash).not.toBe(before);
    expect((await call({ method: "POST", url: `/v1/admin/users/${jen}/password`, payload: { password: "x" }, as: "admin" })).statusCode).toBe(422);
  });

  it("signs a user out everywhere when an admin deactivates them, resets their password or removes a grant", async () => {
    const loginAs = async (key: string) => (await call({ method: "POST", url: "/v1/auth/login", payload: { email: emailFor(key), password: DEV_PASSWORD } })).json();
    const shell = (token: string) => call({ method: "GET", url: "/v1/me/shell", headers: { authorization: `Bearer ${token}` } });
    const refresh = (refreshToken: string) => call({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken } });
    const jen = await userId("jennifer");

    const s1 = await loginAs("jennifer");
    expect((await shell(s1.token)).statusCode).toBe(200);
    expect((await call({ method: "POST", url: `/v1/admin/users/${jen}/active`, payload: { active: false }, as: "admin" })).statusCode).toBe(200);
    expect((await shell(s1.token)).statusCode).toBe(401);
    expect((await refresh(s1.refreshToken)).statusCode).toBe(401);

    await prisma.user.update({ where: { id: jen }, data: { active: true } });
    const s2 = await loginAs("jennifer");
    expect((await call({ method: "POST", url: `/v1/admin/users/${jen}/password`, payload: { password: "newpassword" }, as: "admin" })).statusCode).toBe(200);
    expect((await shell(s2.token)).statusCode).toBe(401);
    expect((await refresh(s2.refreshToken)).statusCode).toBe(401);

    const sara = await userId("sarala");
    const s3 = await loginAs("sarala");
    const grant = await prisma.userTeamRole.findFirstOrThrow({ where: { userId: sara } });
    expect((await call({ method: "DELETE", url: `/v1/admin/grants/${grant.id}`, as: "admin" })).statusCode).toBe(200);
    expect((await shell(s3.token)).statusCode).toBe(401);
    expect((await refresh(s3.refreshToken)).statusCode).toBe(401);
  });
});

describe("HTTP: admin assignment rules", () => {
  it("adds, updates, lists and deletes rules", async () => {
    const jen = await userId("jennifer");
    const add = await call({ method: "POST", url: "/v1/admin/rules", payload: { teamCode: "T1A", category: "NURSE", userId: jen, priority: 2.4, active: true }, as: "admin" });
    expect(add.json().message).toBe("Rule added");
    const rule = await prisma.assignmentRule.findFirstOrThrow({ where: { userId: jen, category: "NURSE", priority: 2 } });
    const upd = await call({ method: "POST", url: "/v1/admin/rules", payload: { id: rule.id, teamCode: "T1A", userId: jen, priority: 5, active: false }, as: "admin" });
    expect(upd.json().message).toBe("Rule updated");
    const page = (await call({ method: "GET", url: "/v1/admin/rules", as: "admin" })).json();
    expect(page.rules.find((r: { id: string }) => r.id === rule.id)).toMatchObject({ category: null, priority: 5, active: false, user: { name: "Jennifer" } });
    expect(page.users.length).toBeGreaterThan(0);
    expect((await call({ method: "DELETE", url: `/v1/admin/rules/${rule.id}`, as: "admin" })).json().message).toBe("Rule deleted");
    expect((await audits("assignment_rule")).map((a) => a.action)).toEqual(["CREATE", "SETTING_CHANGE", "SETTING_CHANGE"]);

    const bad = await call({ method: "POST", url: "/v1/admin/rules", payload: { teamCode: "T1A", active: true }, as: "admin" });
    expect(bad.json().error.message).toBe("Choose the user who receives the leads");
  });
});

describe("HTTP: admin templates", () => {
  it("lists, creates and saves templates with a field diff", async () => {
    const list = (await call({ method: "GET", url: "/v1/admin/templates", as: "admin" })).json();
    expect(list.length).toBeGreaterThan(0);
    const created = await call({ method: "POST", url: "/v1/admin/templates", payload: { key: "welcome_sms", name: "Welcome", channel: "SMS", subject: "ignored", body: "Hi {{name}}", active: true }, as: "admin" });
    expect(created.json().message).toBe("Template created");
    const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { key: "welcome_sms" } });
    expect(t.subject).toBeNull();
    const saved = await call({ method: "POST", url: "/v1/admin/templates", payload: { id: t.id, key: "welcome_sms", name: "Welcome", channel: "SMS", body: "Hello {{name}}", active: true }, as: "admin" });
    expect(saved.json().message).toBe("Template saved");
    const log = await audits("message_template");
    expect(log.map((a) => a.action)).toEqual(["CREATE", "SETTING_CHANGE"]);
    expect(Object.keys(log[1].diff as object)).toEqual(["body"]);

    const clash = await call({ method: "POST", url: "/v1/admin/templates", payload: { key: list[0].key, name: "Dup", channel: "SMS", body: "x", active: true }, as: "admin" });
    expect(clash.json().error.message).toBe(`Another template already uses the key "${list[0].key}"`);
    expect((await call({ method: "POST", url: "/v1/admin/templates", payload: { key: "Bad Key", name: "x", channel: "SMS", body: "x", active: true }, as: "admin" })).statusCode).toBe(422);
  });
});

describe("HTTP: admin settings", () => {
  const form = (over: Record<string, string[]> = {}): Record<string, string[]> => ({
    mandatorySopFields: ["name", "mobile"],
    maxContactAttempts: ["5"],
    "followupHours.UNANSWERED": ["24"],
    "followupHours.INTERESTED_LINK_SENT_NOT_REGISTERED": ["48"],
    "followupHours.BUSY_RECALL_REQUESTED": ["4"],
    availabilityCheckIntervalDays: ["60"],
    cvTargetPerVacancy: ["5"],
    cvMinTeam3bc: ["2"],
    interviewReminderOffsetsHours: ["24, 2"],
    offerFollowupIntervalHours: ["48"],
    retentionDays: ["7, 30"],
    redFlagSlaWorkingDays: ["1"],
    enrolmentLinkTemplate: ["https://nextenti.ai/register?ref={{code}}"],
    ...over,
  });

  it("returns values and defaults, saves a diff and audits it", async () => {
    const page = (await call({ method: "GET", url: "/v1/admin/settings", as: "admin" })).json();
    expect(page.values.maxContactAttempts).toBe(5);
    expect(Object.keys(page.defaults)[0]).toBe("mandatorySopFields");

    const res = await call({ method: "PUT", url: "/v1/admin/settings", payload: { fields: form({ maxContactAttempts: ["7"], retentionDays: ["7 30 90"] }) }, as: "admin" });
    expect(res.json().message).toBe("Saved 3 settings");
    const after = (await call({ method: "GET", url: "/v1/admin/settings", as: "admin" })).json();
    expect(after.values).toMatchObject({ maxContactAttempts: 7, retentionDays: [7, 30, 90], mandatorySopFields: ["name", "mobile"] });
    const [log] = await audits("app_setting");
    expect(log.entityId).toBe("mandatorySopFields,maxContactAttempts,retentionDays");

    const same = await call({ method: "PUT", url: "/v1/admin/settings", payload: { fields: form({ maxContactAttempts: ["7"], retentionDays: ["7 30 90"] }) }, as: "admin" });
    expect(same.json().message).toBe("No changes");
  });

  it("rejects invalid settings with the form's messages", async () => {
    const neg = await call({ method: "PUT", url: "/v1/admin/settings", payload: { fields: form({ maxContactAttempts: ["-1"] }) }, as: "admin" });
    expect(neg.statusCode).toBe(422);
    expect(neg.json().error.message).toBe("Max contact attempts before Unreachable must be a non-negative number");
    const link = await call({ method: "PUT", url: "/v1/admin/settings", payload: { fields: form({ enrolmentLinkTemplate: ["https://x"] }) }, as: "admin" });
    expect(link.json().error.message).toBe("The enrolment link template must contain {{code}}");
    const none = await call({ method: "PUT", url: "/v1/admin/settings", payload: { fields: form({ mandatorySopFields: [] }) }, as: "admin" });
    expect(none.json().error.message).toBe("Pick at least one mandatory SOP field");
  });
});

describe("HTTP: admin holidays", () => {
  it("adds, lists and removes holidays", async () => {
    expect((await call({ method: "POST", url: "/v1/admin/holidays", payload: { date: "2026-11-08", name: "Diwali" }, as: "admin" })).json().message).toBe("Holiday saved");
    const list = (await call({ method: "GET", url: "/v1/admin/holidays", as: "admin" })).json();
    const dates = list.map((h: { date: string }) => h.date);
    expect(dates).toEqual([...dates].sort());
    const diwali = list.find((h: { date: string }) => h.date === "2026-11-08T00:00:00.000Z");
    expect(diwali.name).toBe("Diwali");
    expect((await call({ method: "DELETE", url: `/v1/admin/holidays/${diwali.id}`, as: "admin" })).json().message).toBe("Holiday removed");
    expect((await audits("holiday")).map((a) => (a.diff as { action: string }).action)).toEqual(["added", "removed"]);

    expect((await call({ method: "POST", url: "/v1/admin/holidays", payload: { date: "08-11-2026", name: "Diwali" }, as: "admin" })).json().error.message).toBe("Pick a date");
    expect((await call({ method: "POST", url: "/v1/admin/holidays", payload: { date: "2026-11-08", name: " " }, as: "admin" })).json().error.message).toBe("Name the holiday");
  });
});

describe("HTTP: admin KPI targets", () => {
  it("lists targetable metrics, saves/replaces and deletes targets", async () => {
    await prisma.kpiTarget.deleteMany();
    const page = (await call({ method: "GET", url: "/v1/admin/targets?sheet=T1B", as: "admin" })).json();
    expect(page.metrics.length).toBeGreaterThan(0);
    expect(page.metrics.every((m: { sheet: string; unit: string }) => m.sheet === "T1B" && m.unit !== "ratio")).toBe(true);
    const metricKey = page.metrics[0].key;

    expect((await call({ method: "POST", url: "/v1/admin/targets", payload: { metricKey, periodType: "WEEK", target: 10 }, as: "admin" })).json().message).toBe("Target saved");
    const t = await prisma.kpiTarget.findFirstOrThrow({ where: { metricKey } });
    expect(t).toMatchObject({ teamCode: "T1B", comparator: "gte", target: 10 });
    await call({ method: "POST", url: "/v1/admin/targets", payload: { metricKey, periodType: "WEEK", target: 12, comparator: "lte" }, as: "admin" });
    expect(await prisma.kpiTarget.count()).toBe(1);

    const listed = (await call({ method: "GET", url: "/v1/admin/targets?sheet=T1B", as: "admin" })).json();
    expect(listed.targets).toMatchObject([{ id: t.id, target: 12, comparator: "lte", metric: { key: metricKey } }]);
    expect((await call({ method: "GET", url: "/v1/admin/targets?sheet=T2", as: "admin" })).json().targets).toEqual([]);

    expect((await call({ method: "DELETE", url: `/v1/admin/targets/${t.id}`, as: "admin" })).json().message).toBe("Target deleted");
    expect(await audits("kpi_target")).toHaveLength(3);

    expect((await call({ method: "POST", url: "/v1/admin/targets", payload: { metricKey: "nope", periodType: "WEEK", target: 1 }, as: "admin" })).json().error.message).toBe("Choose a metric");
    expect((await call({ method: "POST", url: "/v1/admin/targets", payload: { metricKey, periodType: "WEEK" }, as: "admin" })).json().error.message).toBe("Enter a target value");
    expect((await call({ method: "POST", url: "/v1/admin/targets", payload: { metricKey, target: 1 }, as: "admin" })).json().error.message).toBe("Choose week or month");
  });
});

describe("HTTP: admin attendance", () => {
  it("returns the week grid and saves it", async () => {
    const page = (await call({ method: "GET", url: "/v1/admin/attendance?week=2026-09-23&team=T1B", as: "admin" })).json();
    expect(page.days).toEqual(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"]);
    expect(page.team).toBe("T1B");
    expect(page.users.map((u: { name: string }) => u.name)).toContain("Bhavani");
    expect(page.users.every((u: { teamCodes: string[] }) => u.teamCodes.includes("T1B"))).toBe(true);
    const all = (await call({ method: "GET", url: "/v1/admin/attendance?team=BOGUS", as: "admin" })).json();
    expect(all.team).toBeNull();
    expect(all.users.map((u: { name: string }) => u.name)).not.toContain("Admin");

    const bhavani = await userId("bhavani");
    const res = await call({ method: "PUT", url: "/v1/admin/attendance", payload: { users: [bhavani], days: page.days, present: [`${bhavani}|2026-09-21`, `${bhavani}|2026-09-22`] }, as: "admin" });
    expect(res.json().message).toBe("Attendance saved (2 present days)");
    const after = (await call({ method: "GET", url: "/v1/admin/attendance?week=2026-09-21&team=T1B", as: "admin" })).json();
    expect(after.present).toEqual(expect.arrayContaining([`${bhavani}|2026-09-21`, `${bhavani}|2026-09-22`]));
    expect(after.recorded.filter((k: string) => k.startsWith(bhavani))).toHaveLength(7);
    expect(await audits("attendance")).toHaveLength(1);

    expect((await call({ method: "PUT", url: "/v1/admin/attendance", payload: { users: [bhavani], days: ["2026-09-21"], present: [] }, as: "admin" })).json().error.message).toBe("Nothing to save");
  });
});

describe("HTTP: admin data deletion", () => {
  it("lists, processes and rejects deletion requests", async () => {
    const a = await newLead({ name: "Delete Me" });
    const b = await newLead({ name: "Keep Me" });
    const ra = await requestDataDeletion(SYSTEM("test"), a.id, { requestedVia: "email", reason: "asked" });
    const rb = await requestDataDeletion(SYSTEM("test"), b.id, { reason: "asked" });

    const page = (await call({ method: "GET", url: "/v1/admin/deletions?status=REQUESTED", as: "admin" })).json();
    expect(page.total).toBe(2);
    expect(page.rows[0].candidate.name).toBeDefined();

    expect((await call({ method: "POST", url: `/v1/admin/deletions/${ra.id}/process`, as: "admin" })).json().message).toBe("Candidate anonymised");
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: a.id } })).name).toBe("[deleted]");
    const again = await call({ method: "POST", url: `/v1/admin/deletions/${ra.id}/process`, as: "admin" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe("This request has already been handled");

    expect((await call({ method: "POST", url: `/v1/admin/deletions/${rb.id}/reject`, payload: { reason: "legal hold" }, as: "admin" })).json().message).toBe("Request rejected");
    expect((await prisma.dataDeletionRequest.findUniqueOrThrow({ where: { id: rb.id } })).reason).toBe("asked · Rejected: legal hold");

    const done = (await call({ method: "GET", url: "/v1/admin/deletions?status=COMPLETED", as: "admin" })).json();
    expect(done.rows).toMatchObject([{ id: ra.id, processedByName: "Admin" }]);
    expect((await call({ method: "GET", url: "/v1/admin/deletions?status=BOGUS", as: "admin" })).statusCode).toBe(422);
  });
});

describe("HTTP: admin audit log", () => {
  it("filters the audit log", async () => {
    await call({ method: "POST", url: "/v1/admin/holidays", payload: { date: "2026-11-08", name: "Diwali" }, as: "admin" });
    const page = (await call({ method: "GET", url: "/v1/admin/audit?entityType=holiday", as: "admin" })).json();
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({ action: "SETTING_CHANGE", actorLabel: "Admin" });
    expect(page.entityTypes).toContain("holiday");
    const byActor = (await call({ method: "GET", url: `/v1/admin/audit?actor=${await userId("admin")}&action=SETTING_CHANGE`, as: "admin" })).json();
    expect(byActor.total).toBe(1);
    expect((await call({ method: "GET", url: "/v1/admin/audit?entityType=holiday&from=2000-01-01&to=2000-01-02", as: "admin" })).json().total).toBe(0);
  });
});

describe("HTTP: admin scheduled jobs", () => {
  it("runs due jobs, freezes KPIs and reports the queue", async () => {
    const run = await call({ method: "POST", url: "/v1/admin/jobs/run", as: "admin" });
    expect(run.statusCode).toBe(200);
    expect(run.json().message).toMatch(/^Ran \d+ jobs?/);
    const freeze = await call({ method: "POST", url: "/v1/admin/kpi/freeze", as: "admin" });
    expect(freeze.json().message).toMatch(/^Freeze: /);
    const actions = (await prisma.auditLog.findMany({ where: { actorLabel: "Admin", action: "JOB_RUN" } })).map((a) => a.entityId);
    expect(actions).toEqual(expect.arrayContaining(["manual-run", "manual-freeze"]));

    const page = (await call({ method: "GET", url: "/v1/admin/jobs", as: "admin" })).json();
    expect(page.counts.PENDING).toBe(page.total);
    expect(page.counts.PENDING).toBeGreaterThan(0);
    expect(page.types.length).toBeGreaterThan(0);
    expect(page.lastFreezeAt).not.toBeNull();
    const done = (await call({ method: "GET", url: "/v1/admin/jobs?status=DONE&page=1", as: "admin" })).json();
    expect(done.total).toBe(page.counts.DONE);
    expect(done.jobs.every((j: { status: string }) => j.status === "DONE")).toBe(true);
    expect((await call({ method: "GET", url: "/v1/admin/jobs?page=0", as: "admin" })).statusCode).toBe(422);
  });
});
