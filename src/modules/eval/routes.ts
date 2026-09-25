import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route } from "@/http/route";
import { idParam, pageQuery } from "@/http/schemas";
import { prisma } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { ForbiddenError } from "@/lib/rbac";
import { createEvaluation, saveScores, saveTemplate } from "./service";
import { canEditTemplates, evaluationDetail, evaluationNewForm, listEvaluations, listTemplates, templateForEdit } from "./queries";

const optStr = z.string().trim().max(500).optional();
const criterionName = z.string().trim().max(200);
const weight = z.number().finite();

export async function evaluationRoutes(app: FastifyInstance) {
  route(app, "GET /v1/evaluations", {
    summary: "Scorecards, newest first",
    query: z.object({ page: pageQuery.optional() }),
    handler: async ({ query }) => listEvaluations(query?.page),
  });

  route(app, "GET /v1/evaluations/new-form", {
    summary: "Templates, vacancies and candidate options for a new evaluation (Team 3 only)",
    query: z.object({ vacancyId: z.string().max(100).optional(), q: z.string().max(200).optional(), candidateId: z.string().max(100).optional() }),
    handler: async ({ actor, query }) => evaluationNewForm(actor, query ?? {}),
  });

  route(app, "POST /v1/evaluations", {
    summary: "Create an evaluation comparing 1–3 candidates",
    body: z.object({ title: optStr, templateId: optStr, vacancyId: z.string().max(100).nullable().optional(), candidateIds: z.array(z.string().min(1)).max(50) }),
    handler: async ({ actor, body }) => {
      if (!body.title) throw new ValidationError("Title is required");
      if (!body.templateId) throw new ValidationError("Choose a template");
      const e = await createEvaluation(actor, { title: body.title, templateId: body.templateId, vacancyId: body.vacancyId || null, candidateIds: body.candidateIds });
      return { message: "Evaluation created", id: e.id };
    },
  });

  route(app, "GET /v1/evaluations/{id}", {
    summary: "Scorecard: criteria grid and ranked results",
    params: idParam,
    handler: async ({ params }) => evaluationDetail(params.id),
  });

  route(app, "POST /v1/evaluations/{id}/scores", {
    summary: "Save 1–5 scores per criterion and candidate",
    params: idParam,
    body: z.object({ scores: z.array(z.object({ criterionId: z.string().min(1), candidateId: z.string().min(1), score: z.number() })).max(2000) }),
    handler: async ({ actor, params, body }) => {
      if (!body.scores.length) throw new ValidationError("Enter at least one score");
      await saveScores(actor, params.id, body.scores);
      return { message: `Saved ${body.scores.length} score(s)` };
    },
  });

  route(app, "GET /v1/evaluation-templates", {
    summary: "Scorecard templates with criteria and usage counts",
    handler: async () => listTemplates(),
  });

  route(app, "GET /v1/evaluation-templates/{id}", {
    summary: "One scorecard template for the editor (admin / Team 3 leader)",
    params: idParam,
    handler: async ({ actor, params }) => templateForEdit(actor, params.id),
  });

  route(app, "POST /v1/evaluation-templates", {
    summary: "Create or update a scorecard template (weights must total 100%)",
    body: z.object({
      id: optStr,
      name: optStr,
      description: z.string().trim().max(2000).optional(),
      criteria: z.array(z.object({ name: criterionName, weightPct: weight.optional(), children: z.array(z.object({ name: criterionName, weightPct: weight })).max(50).optional() })).max(100),
    }),
    handler: async ({ actor, body }) => {
      if (!canEditTemplates(actor)) throw new ForbiddenError("Only admins can edit scorecard templates");
      const { name, id } = body;
      if (!name) throw new ValidationError("Template name is required");
      const criteria = body.criteria.map((c) => (c.children?.length ? { name: c.name, children: c.children } : { name: c.name, weightPct: c.weightPct ?? 0 }));
      if (criteria.some((c) => c.children?.some((ch) => !ch.name))) throw new ValidationError("Sub-criterion names are required");
      if (await prisma.evalTemplate.findFirst({ where: { name, ...(id ? { id: { not: id } } : {}) } })) throw new ValidationError(`A template named "${name}" already exists`);
      const t = await saveTemplate(actor, { id: id || undefined, name, description: body.description || undefined, criteria });
      return { message: "Template saved", id: t.id };
    },
  });
}
