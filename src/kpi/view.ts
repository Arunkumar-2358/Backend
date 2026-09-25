/** KPI display metadata sent to the web UI (labels, units, headline / chart metric lists). Formulas stay server-side. */
import type { KpiMetric } from "@contracts";
import { KPI_BY_KEY, metricsFor, type KpiDef, type Sheet } from "./definitions";

/** Headline metrics per sheet (dashboard mini summary). */
const HEADLINES: Record<Sheet, string[]> = {
  T1A: ["t1a.validated_assigned", "t1a.total_enrolled", "t1a.pct_enrolled_from_validated", "t1a.calls_attempted", "t1a.pct_screened"],
  T1B: ["t1b.ftc_attended", "t1b.ftc_enrolled", "t1b.ftc_attempted_over_allocated", "t1b.mc_recalls", "t1b.mc_recalls_over_missed"],
  T2: ["t2.scrutinised", "t2.qualified", "t2.pct_scrutiny", "t2.vacancies_5_nt", "t2.avg_tat_minutes"],
  T3A: ["t3a.in_hand", "t3a.interviews", "t3a.offers", "t3a.joinings", "t3a.rate_closures"],
  T3B: ["t3b.in_hand", "t3b.min2_cvs", "t3b.interviews", "t3b.joinings", "t3b.rate_closures"],
  T3C: ["t3c.new", "t3c.min2_cvs", "t3c.with_cvs", "t3c.pct_with_cvs"],
  T4_DA: ["t4da.import_rows", "t4da.import_duplicates", "t4da.import_accepted", "t4da.incomplete_enrolled"],
  T4_COORD: ["t4c.flags_t1", "t4c.flags_t2", "t4c.flags_t3", "t4c.closed_within_1wd", "t4c.still_open"],
};

/** Count metrics charted per agent (one unit per chart → one axis). */
const CHART: Record<Sheet, string[]> = {
  T1A: ["t1a.validated_assigned", "t1a.total_enrolled", "t1a.calls_attempted"],
  T1B: ["t1b.ftc_attended", "t1b.ftc_enrolled", "t1b.mc_recalls", "t1b.mc_enrolled"],
  T2: ["t2.enrolled_received", "t2.scrutinised", "t2.qualified"],
  T3A: ["t3a.interviews", "t3a.offers", "t3a.joinings", "t3a.closures"],
  T3B: ["t3b.interviews", "t3b.offers", "t3b.joinings", "t3b.closures"],
  T3C: ["t3c.new", "t3c.min2_cvs", "t3c.with_cvs"],
  T4_DA: ["t4da.import_rows", "t4da.import_duplicates", "t4da.import_accepted"],
  T4_COORD: ["t4c.flags_t1", "t4c.flags_t2", "t4c.flags_t3"],
};

/** Strip a definition down to what the UI shows. */
export const metricMeta = (d: KpiDef): KpiMetric => ({ key: d.key, label: d.label, unit: d.unit, description: d.description, ...(d.teamOnly ? { teamOnly: true } : {}) });

const defs = (keys: string[]) => keys.map((k) => KPI_BY_KEY[k]).filter((d): d is KpiDef => !!d).map(metricMeta);
export const headlineMetrics = (s: Sheet) => defs(HEADLINES[s]);
export const chartMetrics = (s: Sheet) => defs(CHART[s]);
export const sheetMetrics = (s: Sheet) => metricsFor(s).map(metricMeta);
