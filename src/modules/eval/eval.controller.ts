import { z } from "zod";
import { Controller, Module } from "@nestjs/common";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { idParam, pageQuery } from "@/http/schemas";
import { prisma } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { ForbiddenError } from "@/lib/rbac";
import { createEvaluation, saveScores, saveTemplate } from "./service";
import { canEditTemplates, evaluationDetail, evaluationNewForm, listEvaluations, listTemplates, templateForEdit } from "./queries";

const optStr = z.string().trim().max(500).optional();
const criterionName = z.string().trim().max(200);
const weight = z.number().finite();

@Controller()
export class EvaluationsController {
  @Endpoint("GET /v1/evaluations", {
    summary: "Scorecards, newest first",
    query: z.object({ page: pageQuery.optional() }),
  })
  async getEvaluations({ query }: Ctx<"GET /v1/evaluations">) {
    return listEvaluations(query?.page);
  }

  @Endpoint("GET /v1/evaluations/new-form", {
    summary: "Templates, vacancies and candidate options for a new evaluation (Team 3 only)",
    query: z.object({ vacancyId: z.string().max(100).optional(), q: z.string().max(200).optional(), candidateId: z.string().max(100).optional() }),
  })
  async getEvaluationsNewForm({ actor, query }: Ctx<"GET /v1/evaluations/new-form">) {
    return evaluationNewForm(actor, query ?? {});
  }

  @Endpoint("POST /v1/evaluations", {
    summary: "Create an evaluation comparing 1–3 candidates",
    body: z.object({ title: optStr, templateId: optStr, vacancyId: z.string().max(100).nullable().optional(), candidateIds: z.array(z.string().min(1)).max(50) }),
  })
  async postEvaluations({ actor, body }: Ctx<"POST /v1/evaluations">) {
    if (!body.title) throw new ValidationError("Title is required");
    if (!body.templateId) throw new ValidationError("Choose a template");
    const e = await createEvaluation(actor, { title: body.title, templateId: body.templateId, vacancyId: body.vacancyId || null, candidateIds: body.candidateIds });
    return { message: "Evaluation created", id: e.id };
  }

  @Endpoint("GET /v1/evaluations/{id}", {
    summary: "Scorecard: criteria grid and ranked results",
    params: idParam,
  })
  async getEvaluationsDetail({ params }: Ctx<"GET /v1/evaluations/{id}">) {
    return evaluationDetail(params.id);
  }

  @Endpoint("POST /v1/evaluations/{id}/scores", {
    summary: "Save 1–5 scores per criterion and candidate",
    params: idParam,
    body: z.object({ scores: z.array(z.object({ criterionId: z.string().min(1), candidateId: z.string().min(1), score: z.number() })).max(2000) }),
  })
  async postEvaluationsScores({ actor, params, body }: Ctx<"POST /v1/evaluations/{id}/scores">) {
    if (!body.scores.length) throw new ValidationError("Enter at least one score");
    await saveScores(actor, params.id, body.scores);
    return { message: `Saved ${body.scores.length} score(s)` };
  }

  @Endpoint("GET /v1/evaluation-templates", {
    summary: "Scorecard templates with criteria and usage counts",
  })
  async getEvaluationTemplates() {
    return listTemplates();
  }

  @Endpoint("GET /v1/evaluation-templates/{id}", {
    summary: "One scorecard template for the editor (admin / Team 3 leader)",
    params: idParam,
  })
  async getEvaluationTemplatesDetail({ actor, params }: Ctx<"GET /v1/evaluation-templates/{id}">) {
    return templateForEdit(actor, params.id);
  }

  @Endpoint("POST /v1/evaluation-templates", {
    summary: "Create or update a scorecard template (weights must total 100%)",
    body: z.object({
      id: optStr,
      name: optStr,
      description: z.string().trim().max(2000).optional(),
      criteria: z.array(z.object({ name: criterionName, weightPct: weight.optional(), children: z.array(z.object({ name: criterionName, weightPct: weight })).max(50).optional() })).max(100),
    }),
  })
  async postEvaluationTemplates({ actor, body }: Ctx<"POST /v1/evaluation-templates">) {
    if (!canEditTemplates(actor)) throw new ForbiddenError("Only admins can edit scorecard templates");
    const { name, id } = body;
    if (!name) throw new ValidationError("Template name is required");
    const criteria = body.criteria.map((c) => (c.children?.length ? { name: c.name, children: c.children } : { name: c.name, weightPct: c.weightPct ?? 0 }));
    if (criteria.some((c) => c.children?.some((ch) => !ch.name))) throw new ValidationError("Sub-criterion names are required");
    if (await prisma.evalTemplate.findFirst({ where: { name, ...(id ? { id: { not: id } } : {}) } })) throw new ValidationError(`A template named "${name}" already exists`);
    const t = await saveTemplate(actor, { id: id || undefined, name, description: body.description || undefined, criteria });
    return { message: "Template saved", id: t.id };
  }
}

@Module({ controllers: [EvaluationsController] })
export class EvaluationsModule {}
