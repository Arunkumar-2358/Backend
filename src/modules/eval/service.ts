import ExcelJS from "exceljs";
import { prisma, withTx, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";
import { type Actor, ForbiddenError, actorId, hasRole } from "@/lib/rbac";

export { DEFAULT_CRITERIA, type CriterionInput } from "@contracts/shared/labels";
import type { CriterionInput } from "@contracts/shared/labels";

export function leafWeights(criteria: CriterionInput[]): number[] {
  return criteria.flatMap((c) => (c.children?.length ? c.children.map((ch) => ch.weightPct) : [c.weightPct ?? 0]));
}

/** Weights must add up to exactly 100 (M6). */
export function validateWeights(criteria: CriterionInput[]): string[] {
  const errs: string[] = [];
  if (!criteria.length) errs.push("At least one criterion is required");
  for (const w of leafWeights(criteria)) if (!(w > 0)) errs.push("Every weight must be greater than 0");
  const total = leafWeights(criteria).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 100) > 1e-9) errs.push(`Weights total ${Math.round(total * 100) / 100}% — they must add up to exactly 100%`);
  for (const c of criteria) if (!c.name.trim()) errs.push("Criterion names are required");
  return [...new Set(errs)];
}

export async function saveTemplate(actor: Actor, input: { id?: string; name: string; description?: string; criteria: CriterionInput[] }, db: Tx = prisma) {
  if (!hasRole(actor, "admin", "team3_leader")) throw new ForbiddenError("Only admins can edit scorecard templates");
  const errs = validateWeights(input.criteria);
  if (errs.length) throw new ValidationError(errs.join("; "));
  return withTx(db, async (tx) => {
    const t = input.id
      ? await tx.evalTemplate.update({ where: { id: input.id }, data: { name: input.name, description: input.description } })
      : await tx.evalTemplate.create({ data: { name: input.name, description: input.description } });
    if (input.id) {
      const used = await tx.evalScore.count({ where: { criterion: { templateId: t.id } } });
      if (used) throw new ValidationError("This template already has scores; create a new version instead");
      await tx.evalCriterion.deleteMany({ where: { templateId: t.id } });
    }
    let order = 0;
    for (const c of input.criteria) {
      const parent = await tx.evalCriterion.create({ data: { templateId: t.id, name: c.name, weightPct: c.children?.length ? c.children.reduce((a, b) => a + b.weightPct, 0) : c.weightPct ?? 0, sortOrder: order++ } });
      for (const ch of c.children ?? []) await tx.evalCriterion.create({ data: { templateId: t.id, parentId: parent.id, name: ch.name, weightPct: ch.weightPct, sortOrder: order++ } });
    }
    await audit(actor, input.id ? "FIELD_EDIT" : "CREATE", "eval_template", t.id, { criteria: input.criteria }, tx);
    return t;
  });
}

export async function templateLeaves(templateId: string, db: Tx = prisma) {
  const all = await db.evalCriterion.findMany({ where: { templateId }, orderBy: { sortOrder: "asc" } });
  const parents = new Set(all.filter((c) => c.parentId).map((c) => c.parentId));
  return { all, leaves: all.filter((c) => !parents.has(c.id)) };
}

export async function createEvaluation(actor: Actor, input: { title: string; templateId: string; vacancyId?: string | null; interviewId?: string | null; candidateIds: string[] }, db: Tx = prisma) {
  if (!hasRole(actor, "admin", "recruiter", "team3_leader")) throw new ForbiddenError();
  const ids = [...new Set(input.candidateIds.filter(Boolean))];
  if (ids.length < 1 || ids.length > 3) throw new ValidationError("Compare between 1 and 3 candidates");
  return withTx(db, async (tx) => {
    const e = await tx.evaluation.create({ data: { title: input.title, templateId: input.templateId, vacancyId: input.vacancyId, interviewId: input.interviewId, createdById: actorId(actor) } });
    for (let i = 0; i < ids.length; i++) await tx.evaluationCandidate.create({ data: { evaluationId: e.id, candidateId: ids[i], slot: i + 1 } });
    await audit(actor, "CREATE", "evaluation", e.id, { candidates: ids }, tx);
    return e;
  });
}

export async function saveScores(actor: Actor, evaluationId: string, scores: { criterionId: string; candidateId: string; score: number }[], db: Tx = prisma) {
  if (!hasRole(actor, "admin", "recruiter", "team3_leader")) throw new ForbiddenError();
  return withTx(db, async (tx) => {
    const e = await tx.evaluation.findUniqueOrThrow({ where: { id: evaluationId }, include: { candidates: true } });
    const { leaves } = await templateLeaves(e.templateId, tx);
    const leafMap = new Map(leaves.map((l) => [l.id, l]));
    const cands = new Set(e.candidates.map((c) => c.candidateId));
    for (const s of scores) {
      if (!Number.isInteger(s.score) || s.score < 1 || s.score > 5) throw new ValidationError("Scores must be whole numbers from 1 to 5");
      const leaf = leafMap.get(s.criterionId);
      if (!leaf) throw new ValidationError("Unknown criterion");
      if (!cands.has(s.candidateId)) throw new ValidationError("Candidate is not part of this evaluation");
      const net = (leaf.weightPct / 100) * s.score;
      await tx.evalScore.upsert({
        where: { evaluationId_criterionId_candidateId: { evaluationId, criterionId: s.criterionId, candidateId: s.candidateId } },
        create: { evaluationId, criterionId: s.criterionId, candidateId: s.candidateId, score: s.score, net },
        update: { score: s.score, net },
      });
    }
    await audit(actor, "FIELD_EDIT", "evaluation", evaluationId, { scores: scores.length }, tx);
  });
}

export type EvalResult = {
  candidateId: string;
  name: string;
  code: string;
  slot: number;
  total: number; // out of 5
  scaled: number; // out of 100
  complete: boolean;
  rank: number;
  perCriterion: Record<string, { score: number | null; net: number | null }>;
};

/** Net = weight% × score; total out of 5, scaled to 100; ranked. */
export async function evaluationResults(evaluationId: string, db: Tx = prisma) {
  const e = await db.evaluation.findUniqueOrThrow({ where: { id: evaluationId }, include: { candidates: { include: { candidate: true }, orderBy: { slot: "asc" } }, scores: true, template: true, vacancy: true } });
  const { all, leaves } = await templateLeaves(e.templateId, db);
  const results: EvalResult[] = e.candidates.map((ec) => {
    const per: EvalResult["perCriterion"] = {};
    let total = 0;
    let filled = 0;
    for (const l of leaves) {
      const s = e.scores.find((x) => x.criterionId === l.id && x.candidateId === ec.candidateId);
      per[l.id] = { score: s?.score ?? null, net: s ? Math.round(s.net * 1000) / 1000 : null };
      if (s) { total += s.net; filled++; }
    }
    total = Math.round(total * 1000) / 1000;
    return { candidateId: ec.candidateId, name: ec.candidate.name, code: ec.candidate.candidateCode, slot: ec.slot, total, scaled: Math.round(total * 20 * 10) / 10, complete: filled === leaves.length, rank: 0, perCriterion: per };
  });
  [...results].sort((a, b) => b.total - a.total).forEach((r, i, arr) => (r.rank = i > 0 && arr[i - 1].total === r.total ? arr[i - 1].rank : i + 1));
  return { evaluation: e, criteria: all, leaves, results };
}

export async function evaluationWorkbook(evaluationId: string): Promise<Buffer> {
  const { evaluation, criteria, leaves, results } = await evaluationResults(evaluationId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Scorecard");
  ws.addRow([evaluation.title]).font = { bold: true, size: 14 };
  ws.addRow([`Template: ${evaluation.template.name}`]);
  ws.addRow([]);
  const header = ["Criterion", "Sub-criterion", "Weight %", ...results.flatMap((r) => [`${r.name} score`, `${r.name} net`])];
  ws.addRow(header).font = { bold: true };
  const parentName = (id: string | null) => criteria.find((c) => c.id === id)?.name ?? "";
  for (const l of leaves) {
    ws.addRow([l.parentId ? parentName(l.parentId) : l.name, l.parentId ? l.name : "", l.weightPct, ...results.flatMap((r) => [r.perCriterion[l.id].score ?? "", r.perCriterion[l.id].net ?? ""])]);
  }
  ws.addRow(["Total (out of 5)", "", 100, ...results.flatMap((r) => ["", r.total])]).font = { bold: true };
  ws.addRow(["Scaled (out of 100)", "", "", ...results.flatMap((r) => ["", r.scaled])]).font = { bold: true };
  ws.addRow(["Rank", "", "", ...results.flatMap((r) => ["", r.rank])]).font = { bold: true };
  ws.columns.forEach((c, i) => (c.width = i < 2 ? 32 : 16));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
