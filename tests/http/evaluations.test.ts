import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { setClock } from "@/lib/clock";
import { createEvaluation, templateLeaves } from "@/modules/eval/service";
import { resetDb, as, newLead } from "../helpers";
import { driveTo } from "../drive";
import { call } from "./client";

beforeEach(async () => {
  await resetDb();
  setClock("2026-09-21T04:30:00Z");
});

const post = (url: string, as: string, payload: object = {}) => call({ method: "POST", url, as, payload });
const template = () => prisma.evalTemplate.findFirstOrThrow({ where: { name: "Employee grading template" } });

async function evaluationWith(n = 2) {
  const t = await template();
  const cands = [];
  for (let i = 0; i < n; i++) cands.push(await driveTo("SOURCED", { name: `Cand ${i + 1}` }));
  const e = await createEvaluation(await as("harsha"), { title: "ICU panel", templateId: t.id, candidateIds: cands.map((c) => c.id) });
  return { t, e, cands };
}

describe("HTTP: evaluations", () => {
  it("lists evaluations with the creator's name", async () => {
    const { e } = await evaluationWith(1);
    const res = await call({ method: "GET", url: "/v1/evaluations", as: "harsha" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.evaluations[0]).toMatchObject({ id: e.id, creatorName: "Harsha", template: { name: "Employee grading template" } });
    expect(body.evaluations[0].candidates[0].candidate.name).toBe("Cand 1");
  });

  it("new-evaluation form is Team 3 only and loads a vacancy's submissions", async () => {
    const lead = await driveTo("SOURCED", { name: "Submitted" });
    expect((await call({ method: "GET", url: "/v1/evaluations/new-form", as: "jennifer" })).statusCode).toBe(403);
    const res = await call({ method: "GET", url: `/v1/evaluations/new-form?vacancyId=${lead.vacancyId}`, as: "harsha" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.templates.map((t: { name: string }) => t.name)).toContain("Employee grading template");
    expect(body.vacancy.id).toBe(lead.vacancyId);
    expect(body.vacancies.map((v: { id: string }) => v.id)).toContain(lead.vacancyId);
    expect(body.options).toHaveLength(1);
    expect(body.options[0]).toMatchObject({ id: lead.id, name: "Submitted" });
    expect(body.options[0].hint).toMatch(/^submitted /);
    // Search is limited to the caller's lead scope: Harsha does not own this lead.
    const searched = (await call({ method: "GET", url: "/v1/evaluations/new-form?q=Submitted", as: "sanjay" })).json();
    expect(searched.options.map((o: { id: string }) => o.id)).toEqual([lead.id]);
  });

  it("creates an evaluation (Team 3 only, 1–3 candidates)", async () => {
    const t = await template();
    const c = await driveTo("SOURCED");
    expect((await post("/v1/evaluations", "jennifer", { title: "x", templateId: t.id, candidateIds: [c.id] })).statusCode).toBe(403);
    expect((await post("/v1/evaluations", "harsha", { templateId: t.id, candidateIds: [c.id] })).json().error.message).toBe("Title is required");
    expect((await post("/v1/evaluations", "harsha", { title: "x", candidateIds: [c.id] })).json().error.message).toBe("Choose a template");
    const none = await post("/v1/evaluations", "harsha", { title: "x", templateId: t.id, candidateIds: [] });
    expect(none.statusCode).toBe(422);
    expect(none.json().error.message).toBe("Compare between 1 and 3 candidates");
    const ok = await post("/v1/evaluations", "harsha", { title: "Panel", templateId: t.id, candidateIds: [c.id], vacancyId: c.vacancyId });
    expect(ok.statusCode).toBe(200);
    expect((await prisma.evaluation.findUniqueOrThrow({ where: { id: ok.json().id } })).vacancyId).toBe(c.vacancyId);
  });

  it("returns the scorecard and saves scores (Team 3 only, 1–5)", async () => {
    const { t, e, cands } = await evaluationWith(2);
    const { leaves } = await templateLeaves(t.id);
    expect((await call({ method: "GET", url: "/v1/evaluations/nope", as: "harsha" })).statusCode).toBe(404);
    const url = `/v1/evaluations/${e.id}/scores`;
    const scores = cands.flatMap((c, i) => leaves.map((l) => ({ criterionId: l.id, candidateId: c.id, score: i === 0 ? 5 : 3 })));
    expect((await post(url, "jennifer", { scores })).statusCode).toBe(403);
    expect((await post(url, "harsha", { scores: [] })).json().error.message).toBe("Enter at least one score");
    expect((await post(url, "harsha", { scores: [{ ...scores[0], score: 7 }] })).json().error.message).toBe("Scores must be whole numbers from 1 to 5");
    expect((await post(url, "harsha", { scores })).json().message).toBe(`Saved ${scores.length} score(s)`);

    const res = await call({ method: "GET", url: `/v1/evaluations/${e.id}`, as: "harsha" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.evaluation).toMatchObject({ id: e.id, title: "ICU panel", template: { name: t.name }, vacancy: null });
    expect(body.leaves).toHaveLength(10);
    expect(body.results.map((r: { total: number; rank: number; complete: boolean }) => [r.total, r.rank, r.complete])).toEqual([[5, 1, true], [3, 2, true]]);
  });
});

describe("HTTP: evaluation templates", () => {
  it("lists templates for Team 3; the editor view is admin / Team 3 leader only", async () => {
    const t = await template();
    const list = (await call({ method: "GET", url: "/v1/evaluation-templates", as: "harsha" })).json();
    expect(list[0]).toMatchObject({ id: t.id, _count: { evaluations: 0 } });
    expect(list[0].criteria.length).toBeGreaterThan(0);
    expect((await call({ method: "GET", url: `/v1/evaluation-templates/${t.id}`, as: "harsha" })).statusCode).toBe(403);
    expect((await call({ method: "GET", url: `/v1/evaluation-templates/${t.id}`, as: "sanjay" })).json().id).toBe(t.id);
    expect((await call({ method: "GET", url: "/v1/evaluation-templates/nope", as: "sanjay" })).statusCode).toBe(404);
  });

  it("saves templates: role, name, duplicate and weight checks", async () => {
    const criteria = [{ name: "Skill", weightPct: 60 }, { name: "Team", children: [{ name: "Comms", weightPct: 25 }, { name: "Care", weightPct: 15 }] }];
    expect((await post("/v1/evaluation-templates", "harsha", { name: "Nurse v1", criteria })).statusCode).toBe(403);
    expect((await post("/v1/evaluation-templates", "sanjay", { criteria })).json().error.message).toBe("Template name is required");
    expect((await post("/v1/evaluation-templates", "sanjay", { name: "Employee grading template", criteria })).json().error.message).toBe('A template named "Employee grading template" already exists');
    expect((await post("/v1/evaluation-templates", "sanjay", { name: "Nurse v1", criteria: [{ name: "Team", children: [{ name: "", weightPct: 100 }] }] })).json().error.message).toBe("Sub-criterion names are required");
    const weights = await post("/v1/evaluation-templates", "sanjay", { name: "Nurse v1", criteria: [{ name: "A", weightPct: 50 }] });
    expect(weights.statusCode).toBe(422);
    expect(weights.json().error.message).toMatch(/exactly 100%/);
    const ok = await post("/v1/evaluation-templates", "sanjay", { name: "Nurse v1", description: "ICU", criteria });
    expect(ok.statusCode).toBe(200);
    const saved = await prisma.evalTemplate.findUniqueOrThrow({ where: { id: ok.json().id }, include: { criteria: true } });
    expect(saved.criteria).toHaveLength(4);
    // Editing keeps the same name without tripping the duplicate check.
    expect((await post("/v1/evaluation-templates", "admin", { id: saved.id, name: "Nurse v1", criteria: [{ name: "All", weightPct: 100 }] })).statusCode).toBe(200);
  });

  it("does not reveal an out-of-scope lead through the candidateId preselect", async () => {
    const hidden = await newLead({ name: "Hidden Mapping Lead" });
    const res = await call({ method: "GET", url: `/v1/evaluations/new-form?candidateId=${hidden.id}`, as: "harsha" });
    expect(res.statusCode).toBe(200);
    expect(res.json().options.map((o: { id: string }) => o.id)).not.toContain(hidden.id);
  });
});
