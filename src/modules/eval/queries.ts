import type { EvaluationDetail, EvaluationList, EvaluationNewForm, EvalTemplateFull } from "@contracts";
import { prisma } from "@/lib/db";
import { formatDate } from "@contracts/shared/dates";
import { ForbiddenError, hasRole, leadScope, type Actor } from "@/lib/rbac";
import { leadSearchWhere } from "@/modules/search/service";
import { notFound } from "@/lib/http-errors";
import { evaluationResults } from "./service";

const PAGE_SIZE = 25;

export const canScore = (a: Actor) => hasRole(a, "admin", "recruiter", "team3_leader");
export const canEditTemplates = (a: Actor) => hasRole(a, "admin", "team3_leader");

/** Scorecards list, newest first, with the creator's name resolved. */
export async function listEvaluations(pageIn?: number): Promise<EvaluationList> {
  const page = Math.max(1, Math.floor(pageIn ?? 1) || 1);
  const [total, evals] = await Promise.all([
    prisma.evaluation.count(),
    prisma.evaluation.findMany({
      include: {
        vacancy: { select: { id: true, code: true, title: true } },
        template: { select: { name: true } },
        candidates: { select: { candidate: { select: { name: true, candidateCode: true } } }, orderBy: { slot: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
  ]);
  const creators = await prisma.user.findMany({ where: { id: { in: evals.map((e) => e.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const creatorName = new Map(creators.map((u) => [u.id, u.name]));
  return { total, page, pageSize: PAGE_SIZE, evaluations: evals.map((e) => ({ ...e, creatorName: e.createdById ? creatorName.get(e.createdById) ?? null : null })) };
}

/** Data for the "New evaluation" form: templates, vacancies and the candidate options (Team 3 only). */
export async function evaluationNewForm(actor: Actor, sp: { vacancyId?: string; q?: string; candidateId?: string }): Promise<EvaluationNewForm> {
  if (!canScore(actor)) throw new ForbiddenError("Only Team 3 can create evaluations");
  const [templates, vacancies] = await Promise.all([
    prisma.evalTemplate.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.vacancy.findMany({
      where: { OR: [{ status: { not: "CLOSED" } }, ...(sp.vacancyId ? [{ id: sp.vacancyId }] : [])], submissions: { some: {} } },
      orderBy: { postedAt: "desc" },
      take: 200,
      select: { id: true, code: true, title: true, clientOrg: { select: { name: true } } },
    }),
  ]);
  const vacancy = sp.vacancyId ? await prisma.vacancy.findUnique({ where: { id: sp.vacancyId }, select: { id: true, code: true, title: true } }) : null;

  let options: EvaluationNewForm["options"] = [];
  if (vacancy) {
    const subs = await prisma.submission.findMany({
      where: { vacancyId: vacancy.id },
      include: { candidate: { select: { id: true, name: true, candidateCode: true, stage: true } } },
      orderBy: [{ matchScore: "desc" }, { submittedAt: "asc" }],
    });
    options = subs.map((s) => ({ ...s.candidate, hint: `submitted ${formatDate(s.submittedAt)}${s.matchScore !== null ? ` · match ${s.matchScore}` : ""}` }));
  } else if (sp.q?.trim()) {
    const q = sp.q.trim();
    options = await prisma.candidate.findMany({
      where: { AND: [leadScope(actor), { anonymizedAt: null }, leadSearchWhere(q) ?? {}] },
      select: { id: true, name: true, candidateCode: true, stage: true },
      orderBy: { candidateCode: "asc" },
      take: 25,
    });
  }
  if (sp.candidateId && !options.some((o) => o.id === sp.candidateId)) {
    const c = await prisma.candidate.findFirst({ where: { AND: [{ id: sp.candidateId }, leadScope(actor)] }, select: { id: true, name: true, candidateCode: true, stage: true } });
    if (c) options.unshift(c);
  }
  return { templates, vacancies, vacancy, options };
}

/** Scorecard page: criteria, leaves and ranked results. */
export async function evaluationDetail(id: string): Promise<EvaluationDetail> {
  if (!(await prisma.evaluation.findUnique({ where: { id }, select: { id: true } }))) throw notFound("Evaluation not found");
  const { evaluation: e, criteria, leaves, results } = await evaluationResults(id);
  const crit = (c: (typeof criteria)[number]) => ({ id: c.id, parentId: c.parentId, name: c.name, weightPct: c.weightPct });
  return {
    evaluation: {
      id: e.id,
      title: e.title,
      createdAt: e.createdAt,
      template: { name: e.template.name },
      vacancy: e.vacancy ? { id: e.vacancy.id, code: e.vacancy.code, title: e.vacancy.title } : null,
    },
    criteria: criteria.map(crit),
    leaves: leaves.map(crit),
    results,
  };
}

const templateInclude = { criteria: true, _count: { select: { evaluations: true } } } as const;

export async function listTemplates(): Promise<EvalTemplateFull[]> {
  return prisma.evalTemplate.findMany({ include: templateInclude, orderBy: [{ active: "desc" }, { name: "asc" }] });
}

/** One template with its criteria, for the editor (admins and the Team 3 leader only). */
export async function templateForEdit(actor: Actor, id: string): Promise<EvalTemplateFull> {
  if (!canEditTemplates(actor)) throw new ForbiddenError("Only admins and the Team 3 leader can edit scorecard templates");
  const t = await prisma.evalTemplate.findUnique({ where: { id }, include: templateInclude });
  if (!t) throw notFound("Template not found");
  return t;
}
