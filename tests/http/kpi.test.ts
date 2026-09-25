import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { SYSTEM } from "@/lib/rbac";
import { emailFor } from "@/modules/seed/core";
import { createTask } from "@/modules/tasks/service";
import { raiseRedFlag } from "@/modules/redflags/service";
import { resetDb, as, userId } from "../helpers";
import { call } from "./client";

beforeEach(resetDb);

describe("HTTP: KPI sheet", () => {
  it("gives leaders every sheet, every agent column and display metadata only", async () => {
    const res = await call({ method: "GET", url: "/v1/kpi?period=WEEK&sheet=T1A", as: "sarala" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seesAll).toBe(true);
    expect(body.canExport).toBe(true);
    expect(body.sheets).toContain("T4_COORD");
    expect(body.sheet).toBe("T1A");
    expect(body.table.members.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(["Jennifer", "Poojitha"]));
    expect(Object.keys(body.table.team).length).toBeGreaterThan(0);
    expect(body.metrics[0]).toEqual(expect.objectContaining({ key: expect.any(String), label: expect.any(String), unit: expect.any(String) }));
    expect(body.metrics[0]).not.toHaveProperty("compute");
    expect(body.chartMetrics.length).toBeGreaterThan(0);
    expect(body.period.periodType).toBe("WEEK");
    expect(body.flags).toEqual({ noticed: "", actions: "", count: 0 });
  });

  it("scopes an agent to their own sheet and column, without the team total or export", async () => {
    const body = (await call({ method: "GET", url: "/v1/kpi?sheet=T4_COORD", as: "jennifer" })).json();
    expect(body.sheets).toEqual(["T1A"]);
    expect(body.sheet).toBe("T1A");
    expect(body.seesAll).toBe(false);
    expect(body.canExport).toBe(false);
    expect(body.table.members.map((m: { name: string }) => m.name)).toEqual(["Jennifer"]);
    expect(body.table.team).toEqual({});
  });

  it("returns no sheet for a user whose role has none", async () => {
    await prisma.user.create({ data: { email: emailFor("nobody"), name: "Nobody", passwordHash: "x" } });
    const body = (await call({ method: "GET", url: "/v1/kpi", as: "nobody" })).json();
    expect(body.sheets).toEqual([]);
    expect(body.sheet).toBeNull();
    expect(body.table).toBeNull();
  });

  it("requires a session", async () => {
    expect((await call({ method: "GET", url: "/v1/kpi" })).statusCode).toBe(401);
  });

  it("still refuses the KPI export to agents", async () => {
    expect((await call({ method: "GET", url: "/v1/kpi/export", as: "jennifer" })).statusCode).toBe(403);
  });
});

describe("HTTP: dashboard", () => {
  it("shows an agent their own tasks and nothing role-specific", async () => {
    await createTask(SYSTEM("test"), { type: "FOLLOW_UP", title: "Call back", assigneeId: await userId("jennifer"), dueAt: new Date(Date.now() - 60_000), notify: false });
    await createTask(SYSTEM("test"), { type: "FOLLOW_UP", title: "Not mine", assigneeId: await userId("bhavani"), dueAt: new Date(), notify: false });
    const res = await call({ method: "GET", url: "/v1/dashboard", as: "jennifer" });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.openTasks).toBe(1);
    expect(d.overdueTasks).toBe(1);
    expect(d.topTasks).toHaveLength(1);
    expect(d.teamPipeline).toBeNull();
    expect(d.kpiSummaries).toEqual([]);
    expect(d.coordinator).toBeNull();
    expect(d.dataAnalyst).toBeNull();
  });

  it("adds the team pipeline and weekly KPI headlines for leaders", async () => {
    const d = (await call({ method: "GET", url: "/v1/dashboard", as: "sarala" })).json();
    expect(d.teamPipeline.stages.length).toBeGreaterThan(0);
    expect(d.kpiSummaries.map((s: { sheet: string }) => s.sheet)).toEqual(["T1A", "T1B"]);
    expect(d.kpiSummaries[0].metrics[0].label).toEqual(expect.any(String));
    expect(d.coordinator).toBeNull();
  });

  it("adds red-flag and funnel panels for the coordinator, and import panels for the data analyst", async () => {
    await raiseRedFlag(await as("sumitha"), { teamCode: "T1A", description: "Late calls" });
    const coord = (await call({ method: "GET", url: "/v1/dashboard", as: "sumitha" })).json();
    expect(coord.coordinator.openFlags).toBe(1);
    expect(coord.coordinator.recentFlags[0].description).toBe("Late calls");
    expect(coord.dataAnalyst).toBeNull();
    const da = (await call({ method: "GET", url: "/v1/dashboard", as: "greeshma" })).json();
    expect(da.dataAnalyst).toEqual({ mappingCount: 0, stuckMapping: [], batches: [] });
    expect(da.coordinator).toBeNull();
  });
});
