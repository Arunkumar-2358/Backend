// Endpoints for the evaluations (scorecards) domain. See contracts/README.md.
// The .xlsx download is the raw route GET /v1/evaluations/{id}/export (src/modules/exports/routes.ts).
import type { Candidate, ClientOrg, EvalCriterion, EvalTemplate, Evaluation, Stage, Vacancy } from "../models";
import type { MessageResult } from "../http";
import type { CriterionInput } from "../shared/labels";

type VacancyRef = Pick<Vacancy, "id" | "code" | "title">;

export type EvaluationListRow = Evaluation & {
  vacancy: VacancyRef | null;
  template: Pick<EvalTemplate, "name">;
  candidates: { candidate: Pick<Candidate, "name" | "candidateCode"> }[];
  creatorName: string | null;
};

export interface EvaluationList {
  total: number;
  page: number;
  pageSize: number;
  evaluations: EvaluationListRow[];
}

export type EvaluationCandidateOption = { id: string; name: string; candidateCode: string; stage: Stage; hint?: string };

export interface EvaluationNewForm {
  templates: Pick<EvalTemplate, "id" | "name">[];
  vacancies: (VacancyRef & { clientOrg: Pick<ClientOrg, "name"> })[];
  vacancy: VacancyRef | null;
  options: EvaluationCandidateOption[];
}

export type EvalResultRow = {
  candidateId: string;
  name: string;
  code: string;
  slot: number;
  total: number;
  scaled: number;
  complete: boolean;
  rank: number;
  perCriterion: Record<string, { score: number | null; net: number | null }>;
};

export type EvalCriterionRow = Pick<EvalCriterion, "id" | "parentId" | "name" | "weightPct">;

export interface EvaluationDetail {
  evaluation: Pick<Evaluation, "id" | "title" | "createdAt"> & { template: Pick<EvalTemplate, "name">; vacancy: VacancyRef | null };
  criteria: EvalCriterionRow[];
  leaves: EvalCriterionRow[];
  results: EvalResultRow[];
}

export type EvalTemplateFull = EvalTemplate & { criteria: EvalCriterion[]; _count: { evaluations: number } };

type Id = { params: { id: string } };

export interface EvaluationRoutes {
  "GET /v1/evaluations": { query?: { page?: number }; response: EvaluationList };
  "GET /v1/evaluations/new-form": { query?: { vacancyId?: string; q?: string; candidateId?: string }; response: EvaluationNewForm };
  "POST /v1/evaluations": { body: { title?: string; templateId?: string; vacancyId?: string | null; candidateIds: string[] }; response: MessageResult & { id: string } };
  "GET /v1/evaluations/{id}": Id & { response: EvaluationDetail };
  "POST /v1/evaluations/{id}/scores": Id & { body: { scores: { criterionId: string; candidateId: string; score: number }[] }; response: MessageResult };

  "GET /v1/evaluation-templates": { response: EvalTemplateFull[] };
  "GET /v1/evaluation-templates/{id}": Id & { response: EvalTemplateFull };
  "POST /v1/evaluation-templates": { body: { id?: string; name?: string; description?: string; criteria: CriterionInput[] }; response: MessageResult & { id: string } };
}
