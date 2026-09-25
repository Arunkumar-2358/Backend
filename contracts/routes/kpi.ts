// Endpoints for the kpi domain (KPI sheets and the role dashboard). See contracts/README.md.
import type { Candidate, ImportBatch, KpiTarget, PeriodType, RedFlag, Stage, Task, User } from "../models";
import type { Sheet, Unit } from "../shared/kpi";

/** Display metadata for one KPI metric. The formula stays in the API. */
export interface KpiMetric {
  key: string;
  label: string;
  unit: Unit;
  description: string;
  teamOnly?: boolean;
}

export type KpiValues = Record<string, number | null>;

export interface KpiPeriod {
  periodType: PeriodType;
  start: Date;
  end: Date;
  lastDay: Date;
  prevDate: string;
  nextDate: string;
  dateKey: string;
  /** The period has already ended. */
  isPast: boolean;
}

export interface KpiSheetPage {
  period: KpiPeriod;
  /** Sheets the caller may see (empty = no KPI sheet applies to their role). */
  sheets: Sheet[];
  /** The selected sheet, or null when none is visible. */
  sheet: Sheet | null;
  /** Leaders, coordinator, admin and data analyst see every agent column and the team total. */
  seesAll: boolean;
  canExport: boolean;
  table: { title: string; members: { id: string; name: string; values: KpiValues }[]; team: KpiValues } | null;
  metrics: KpiMetric[];
  chartMetrics: KpiMetric[];
  targets: Pick<KpiTarget, "metricKey" | "target" | "comparator">[];
  snapshotFrozenAt: Date | null;
  flags: { noticed: string; actions: string; count: number } | null;
}

export type StageCountMap = Partial<Record<Stage, number>>;

export interface DashboardView {
  openTasks: number;
  overdueTasks: number;
  topTasks: (Task & { candidate: Pick<Candidate, "id" | "name" | "candidateCode"> | null })[];
  followupsToday: (Task & { candidate: Pick<Candidate, "id" | "name" | "candidateCode" | "stage"> | null })[];
  myStages: StageCountMap;
  /** Team leaders: stages their teams own and the lead counts in them. */
  teamPipeline: { stages: Stage[]; counts: StageCountMap } | null;
  week: { start: Date; end: Date };
  kpiSummaries: { sheet: Sheet; title: string; metrics: KpiMetric[]; values: KpiValues }[];
  /** Coordinator / admin. */
  coordinator: {
    orgFunnel: StageCountMap;
    openFlags: number;
    overdueCapas: number;
    recentFlags: (RedFlag & { agent: Pick<User, "name"> | null })[];
  } | null;
  /** Data analyst. */
  dataAnalyst: {
    mappingCount: number;
    stuckMapping: Pick<Candidate, "id" | "name" | "candidateCode" | "stageChangedAt" | "mainCategory">[];
    batches: ImportBatch[];
  } | null;
}

export interface KpiRoutes {
  "GET /v1/kpi": { query?: { period?: string; date?: string; sheet?: string }; response: KpiSheetPage };
  "GET /v1/dashboard": { response: DashboardView };
}
