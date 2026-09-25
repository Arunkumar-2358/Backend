import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { setClock, advanceClock, HOUR, DAY } from "@/lib/clock";
import { SYSTEM } from "@/lib/rbac";
import { saveTemplate, createEvaluation, saveScores, evaluationResults, templateLeaves, evaluationWorkbook } from "@/modules/eval/service";
import { raiseRedFlag, suggestCapa, implementCapa, verifyAndClose } from "@/modules/redflags/service";
import { evaluateTargets } from "@/kpi/snapshots";
import { resetDb, as, userId } from "./helpers";
import { driveTo } from "./drive";

beforeEach(async () => {
  await resetDb();
  setClock("2026-09-21T04:30:00Z");
});

describe("scorecard (M6)", () => {
  it("refuses to save a template whose weights do not total 100", async () => {
    await expect(saveTemplate(await as("admin"), { name: "Bad", criteria: [{ name: "A", weightPct: 50 }, { name: "B", weightPct: 40 }] })).rejects.toThrow(/exactly 100/);
    await expect(saveTemplate(await as("harsha"), { name: "X", criteria: [{ name: "A", weightPct: 100 }] })).rejects.toThrow(/admin/);
  });

  it("compares up to 3 candidates with net = weight × score, ranked", async () => {
    const t = await prisma.evalTemplate.findFirstOrThrow();
    const c = await Promise.all([driveTo("SOURCED"), driveTo("SOURCED"), driveTo("SOURCED")]);
    const four = await driveTo("SOURCED");
    await expect(createEvaluation(await as("harsha"), { title: "x", templateId: t.id, candidateIds: [...c.map((x) => x.id), four.id] })).rejects.toThrow(/3/);
    const e = await createEvaluation(await as("harsha"), { title: "ICU nurse", templateId: t.id, candidateIds: c.map((x) => x.id) });
    const { leaves } = await templateLeaves(t.id);
    expect(leaves).toHaveLength(10);
    const scores = [5, 3, 4];
    await saveScores(await as("harsha"), e.id, c.flatMap((cand, i) => leaves.map((l) => ({ criterionId: l.id, candidateId: cand.id, score: scores[i] }))));
    await expect(saveScores(await as("harsha"), e.id, [{ criterionId: leaves[0].id, candidateId: c[0].id, score: 6 }])).rejects.toThrow(/1 to 5/);
    const r = await evaluationResults(e.id);
    expect(r.results.map((x) => [x.total, x.scaled, x.rank])).toEqual([[5, 100, 1], [3, 60, 3], [4, 80, 2]]);
    // weighted: domain knowledge (20%) scored 1, rest 5 → 5 - 0.2*4 = 4.2
    await saveScores(await as("harsha"), e.id, [{ criterionId: leaves.find((l) => l.name === "Domain knowledge")!.id, candidateId: c[0].id, score: 1 }]);
    expect((await evaluationResults(e.id)).results[0].total).toBe(4.2);
    const wb = await evaluationWorkbook(e.id);
    expect(wb.length).toBeGreaterThan(1000);
  });
});

describe("red flags / CAPA (M7)", () => {
  it("only coordinator/admin raise; workflow open → CAPA → implemented → closed with SLA", async () => {
    await expect(raiseRedFlag(await as("sarala"), { teamCode: "T1A", description: "x" })).rejects.toThrow(/coordinator/);
    const coord = await as("sumitha");
    const f = await raiseRedFlag(coord, { teamCode: "T1A", description: "Low enrolment", agentId: await userId("jennifer") });
    await expect(verifyAndClose(coord, f.id, undefined)).rejects.toThrow(/implemented/);
    await suggestCapa(coord, f.id, { capaSuggested: "Retrain on pitch", actionOwnerId: await userId("sarala"), dueDate: new Date("2026-09-22T12:00:00Z") });
    await expect(implementCapa(await as("jennifer"), f.id, { correctiveActionImplemented: "x" })).rejects.toThrow(/action owner/);
    await implementCapa(await as("sarala"), f.id, { correctiveActionImplemented: "Pitch retraining done" });
    advanceClock(20 * HOUR);
    const closed = await verifyAndClose(coord, f.id, "Improved");
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedWithin1WorkingDay).toBe(true);
  });

  it("closure after the next working day is beyond SLA (Sunday + holiday skipped)", async () => {
    setClock("2026-10-01T04:30:00Z"); // Thu; Fri 02-10 is Gandhi Jayanti
    const coord = await as("sumitha");
    const f = await raiseRedFlag(coord, { teamCode: "T2", description: "TAT breach" });
    await suggestCapa(coord, f.id, { capaSuggested: "x", actionOwnerId: await userId("dixha") });
    await implementCapa(await as("dixha"), f.id, { correctiveActionImplemented: "y" });
    setClock("2026-10-03T04:00:00Z"); // Sat, before the deadline
    expect((await verifyAndClose(coord, f.id, undefined)).closedWithin1WorkingDay).toBe(true);
    const g = await raiseRedFlag(coord, { teamCode: "T2", description: "TAT breach 2" });
    await suggestCapa(coord, g.id, { capaSuggested: "x", actionOwnerId: await userId("dixha") });
    await implementCapa(await as("dixha"), g.id, { correctiveActionImplemented: "y" });
    setClock("2026-10-05T05:00:00Z"); // Mon, past Mon 04:00 deadline (Sat → skip Sun → Mon)
    expect((await verifyAndClose(coord, g.id, undefined)).closedWithin1WorkingDay).toBe(false);
  });

  it("raises automatic red flags when a KPI misses its target (once per period)", async () => {
    // Jennifer is assigned 10 validated leads and enrols 1 → 10% < 20% target
    const leads = [];
    for (let i = 0; i < 10; i++) leads.push(await driveTo("VALIDATED", { mainCategory: "NURSE" }));
    const { logContact } = await import("@/modules/outreach/service");
    await logContact(await as("jennifer"), leads[0].id, { channel: "CALL", outcome: "ENROLLED" });
    const n = await evaluateTargets("WEEK", new Date());
    expect(n).toBeGreaterThanOrEqual(1);
    const flag = await prisma.redFlag.findFirstOrThrow({ where: { kpiKey: "t1a.pct_enrolled_from_validated" } });
    expect(flag).toMatchObject({ autoRaised: true, teamCode: "T1A", agentId: await userId("jennifer"), actual: "10%", targetStandard: "≥ 20%" });
    await evaluateTargets("WEEK", new Date());
    expect(await prisma.redFlag.count({ where: { kpiKey: "t1a.pct_enrolled_from_validated" } })).toBe(1);
    void SYSTEM; void DAY;
  });
});
