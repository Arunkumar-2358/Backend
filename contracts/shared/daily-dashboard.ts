/**
 * Daily dashboard: the TA team 1 / team 2 "monthly dash board" workbooks, computed from
 * CRM events instead of typed in. One row per day of the month, weekly (Mon–Sun) and
 * monthly totals, and the KPI rows — same columns and formulas as the workbooks.
 * The API fills the values; the web page and the Excel export both render from this layout.
 */
import { IST_OFFSET_MS } from "./dates";

export type DailySheet = "T1A" | "T2";
export const DAILY_SHEETS: DailySheet[] = ["T1A", "T2"];

export type DailyColumn =
  /** a registry KPI computed for the row's day */
  | { key: string; label: string; kind: "metric"; metric: string }
  /** the sum of other columns in the same row (the workbook's own formulas) */
  | { key: string; label: string; kind: "sum"; of: string[] }
  /** text from the job postings given that day */
  | { key: string; label: string; kind: "postings"; field: "description" | "mandatoryAttributes" }
  /** red flags raised that day: description, action suggested, open / closed, TAT */
  | { key: string; label: string; kind: "flags" };

export type DailyKpi =
  /** num / sum(den), × 100 for percentages; null when the base is 0 */
  | { key: string; under: string; label: string; num: string; den: string[]; unit: "pct" | "avg" }
  | { key: string; under: string; label: string; flags: "new" | "closed" | "days" };

export type DailySection = { key: string; title: string; columns: DailyColumn[]; kpis: DailyKpi[] };

const FLAGS: DailyColumn = { key: "flags", label: "Red flags on this day (action suggested · open / closed · TAT)", kind: "flags" };
const FLAG_KPIS = (s: string): DailyKpi[] => [
  { key: `${s}.flags_new`, under: `${s}.flags`, label: "Number of new red flags", flags: "new" },
  { key: `${s}.flags_closed`, under: `${s}.flags`, label: "Number of closed red flags", flags: "closed" },
  { key: `${s}.flags_days`, under: `${s}.flags`, label: "Total days taken to close the red flags", flags: "days" },
];

export const DAILY_LAYOUT: Record<DailySheet, { title: string; sections: DailySection[] }> = {
  T1A: {
    title: "TA team 1 — daily dashboard",
    sections: [
      {
        key: "a",
        title: "For the allocated validated leads",
        columns: [
          { key: "a.allocated", label: "Number of allocated verified leads", kind: "metric", metric: "t1a.validated_assigned" },
          { key: "a.attempted", label: "Number of attempted leads", kind: "metric", metric: "t1a.leads_attempted" },
          { key: "a.answered", label: "Number of answered calls", kind: "metric", metric: "t1a.leads_answered" },
          { key: "a.interested", label: "Number of interested calls (enrolment link sent)", kind: "metric", metric: "t1a.leads_interested" },
          { key: "a.enrolled_first", label: "Number of enrolled leads from the allocated verified leads", kind: "metric", metric: "t1a.enrolled_first_attempt" },
          { key: "a.followups", label: "Number of follow-ups done on pending interested leads not yet enrolled", kind: "metric", metric: "t1a.followups_done" },
          { key: "a.enrolled_reattempt", label: "Number of enrolled leads from the re-attempted verified leads", kind: "metric", metric: "t1a.enrolled_reattempted" },
          { key: "a.total_enrolled", label: "Total number of enrolled leads", kind: "sum", of: ["a.enrolled_first", "a.enrolled_reattempt"] },
          { key: "a.scrutinised", label: "Number of enrolled leads scrutinised by the team leader", kind: "metric", metric: "t1a.nt_screened" },
          { key: "a.approved", label: "Number of enrolled leads verified and approved by the team leader", kind: "metric", metric: "t1a.nt_approved" },
          { ...FLAGS, key: "a.flags" },
        ],
        kpis: [
          { key: "a.k_attempted", under: "a.attempted", label: "% of attempted leads over allocated leads", num: "a.attempted", den: ["a.allocated"], unit: "pct" },
          { key: "a.k_answered", under: "a.answered", label: "% of answered leads over attempted leads", num: "a.answered", den: ["a.attempted"], unit: "pct" },
          { key: "a.k_interested", under: "a.interested", label: "% of interested leads over answered leads", num: "a.interested", den: ["a.answered"], unit: "pct" },
          { key: "a.k_enrolled_first", under: "a.enrolled_first", label: "% of enrolled leads from the interested leads", num: "a.enrolled_first", den: ["a.interested"], unit: "pct" },
          { key: "a.k_followups", under: "a.followups", label: "% of enrolled leads from the answered leads", num: "a.enrolled_first", den: ["a.answered"], unit: "pct" },
          { key: "a.k_enrolled_reattempt", under: "a.enrolled_reattempt", label: "% of enrolled leads over the re-attempted interested leads", num: "a.enrolled_reattempt", den: ["a.followups"], unit: "pct" },
          { key: "a.k_total_enrolled", under: "a.total_enrolled", label: "% of the total enrolled leads over answered leads", num: "a.total_enrolled", den: ["a.answered"], unit: "pct" },
          { key: "a.k_scrutinised", under: "a.scrutinised", label: "% of scrutiny of enrolled leads by the team leader", num: "a.scrutinised", den: ["a.total_enrolled"], unit: "pct" },
          { key: "a.k_approved", under: "a.approved", label: "% of approved leads over scrutinised leads", num: "a.approved", den: ["a.scrutinised"], unit: "pct" },
          ...FLAG_KPIS("a"),
        ],
      },
      {
        key: "b",
        title: "For the allocated job postings",
        columns: [
          { key: "b.postings", label: "Number of job postings given for this day", kind: "metric", metric: "t1a.job_postings" },
          { key: "b.description", label: "Description of each job post", kind: "postings", field: "description" },
          { key: "b.attributes", label: "Mandatory attributes of each job post", kind: "postings", field: "mandatoryAttributes" },
          { key: "b.vacancies", label: "Number of vacancies", kind: "metric", metric: "t1a.job_openings" },
          { key: "b.cvs_other", label: "Number of matching CVs downloaded from non-LinkedIn job portals", kind: "metric", metric: "t1a.cvs_other_portals" },
          { key: "b.cvs_linkedin", label: "Number of matching CVs downloaded from LinkedIn", kind: "metric", metric: "t1a.cvs_linkedin" },
          { key: "b.shortlisted", label: "Total number of matching CVs shortlisted by the executive", kind: "sum", of: ["b.cvs_other", "b.cvs_linkedin"] },
          { key: "b.scrutinised", label: "Number of enrolled leads scrutinised by the team leader", kind: "metric", metric: "t1a.portal_screened" },
          { key: "b.approved", label: "Number of enrolled leads verified and approved by the team leader", kind: "metric", metric: "t1a.portal_approved" },
          { key: "b.total_enrolled_cvs", label: "Total enrolled CVs", kind: "sum", of: ["b.shortlisted", "a.total_enrolled"] },
        ],
        kpis: [
          { key: "b.k_shortlisted", under: "b.shortlisted", label: "Average number of matching CVs downloaded per vacancy", num: "b.shortlisted", den: ["b.vacancies"], unit: "avg" },
          { key: "b.k_scrutinised", under: "b.scrutinised", label: "% of scrutiny of enrolled leads by the team leader", num: "b.scrutinised", den: ["b.shortlisted"], unit: "pct" },
          { key: "b.k_approved", under: "b.approved", label: "% of approved leads over scrutinised leads", num: "b.approved", den: ["b.scrutinised"], unit: "pct" },
        ],
      },
    ],
  },
  T2: {
    title: "TA team 2 — daily dashboard",
    sections: [
      {
        key: "a",
        title: "For the allocated job postings",
        columns: [
          { key: "a.postings", label: "Number of job postings given for this day", kind: "metric", metric: "t2.job_postings" },
          { key: "a.description", label: "Description of each job post", kind: "postings", field: "description" },
          { key: "a.attributes", label: "Mandatory attributes of each job post", kind: "postings", field: "mandatoryAttributes" },
          { key: "a.vacancies", label: "Number of vacancies", kind: "metric", metric: "t2.job_openings" },
          { key: "a.cvs_nt", label: "Number of matching CVs from NT job portals", kind: "metric", metric: "t2.cvs_nt" },
          { key: "a.cvs_nonnt", label: "Number of matching CVs from non-NT job portals", kind: "metric", metric: "t2.cvs_nonnt" },
          { key: "a.shortlisted", label: "Total number of matching CVs shortlisted by the executive", kind: "sum", of: ["a.cvs_nt", "a.cvs_nonnt"] },
          { key: "a.scrutinised", label: "Number of enrolled leads scrutinised by the team leader", kind: "metric", metric: "t2.scrutinised" },
          { key: "a.approved", label: "Number of enrolled leads verified and approved by the team leader", kind: "metric", metric: "t2.qualified" },
          { key: "a.to_team3", label: "Number of matching CVs given to Team 3", kind: "metric", metric: "t2.cvs_to_team3" },
          { ...FLAGS, key: "a.flags" },
        ],
        kpis: [
          { key: "a.k_cvs_nt", under: "a.cvs_nt", label: "% of matching CVs from the NT platform", num: "a.cvs_nt", den: ["a.shortlisted"], unit: "pct" },
          { key: "a.k_cvs_nonnt", under: "a.cvs_nonnt", label: "% of matching CVs from non-NT portals", num: "a.cvs_nonnt", den: ["a.shortlisted"], unit: "pct" },
          { key: "a.k_shortlisted", under: "a.shortlisted", label: "Average number of matching CVs per vacancy", num: "a.shortlisted", den: ["a.vacancies"], unit: "avg" },
          { key: "a.k_scrutinised", under: "a.scrutinised", label: "% of scrutiny of enrolled leads by the team leader", num: "a.scrutinised", den: ["a.shortlisted"], unit: "pct" },
          { key: "a.k_approved", under: "a.approved", label: "% of approved leads over scrutinised leads", num: "a.approved", den: ["a.scrutinised"], unit: "pct" },
          { key: "a.k_to_team3", under: "a.to_team3", label: "% of the matching CVs given to Team 3", num: "a.to_team3", den: ["a.approved"], unit: "pct" },
          ...FLAG_KPIS("a"),
        ],
      },
      {
        key: "b",
        title: "For the allocated cold leads",
        columns: [
          { key: "b.allocated", label: "Number of allocated cold leads", kind: "metric", metric: "t2.cold_allocated" },
          { key: "b.attempted", label: "Number of attempted cold leads", kind: "metric", metric: "t2.cold_attempted" },
          { key: "b.answered", label: "Number of answered cold leads", kind: "metric", metric: "t2.cold_answered" },
          { key: "b.super_active", label: "Number of super active leads out of answered cold leads", kind: "metric", metric: "t2.cold_super_active" },
          { key: "b.recalled", label: "Number of unanswered cold leads recalled", kind: "metric", metric: "t2.cold_recalled" },
          { key: "b.recall_answered", label: "Number of answered re-attempted cold leads", kind: "metric", metric: "t2.cold_recall_answered" },
          { key: "b.recall_super_active", label: "Number of super active leads out of re-attempted answered cold leads", kind: "metric", metric: "t2.cold_recall_super_active" },
          { key: "b.total_super_active", label: "Total number of super active leads", kind: "sum", of: ["b.super_active", "b.recall_super_active"] },
        ],
        kpis: [
          { key: "b.k_attempted", under: "b.attempted", label: "% of attempted cold leads over allocated cold leads", num: "b.attempted", den: ["b.allocated"], unit: "pct" },
          { key: "b.k_answered", under: "b.answered", label: "% of answered cold leads over attempted cold leads", num: "b.answered", den: ["b.attempted"], unit: "pct" },
          { key: "b.k_super_active", under: "b.super_active", label: "% of super active leads out of answered cold leads", num: "b.super_active", den: ["b.answered"], unit: "pct" },
          { key: "b.k_recall_answered", under: "b.recall_answered", label: "% of answered re-attempted cold leads", num: "b.recall_answered", den: ["b.recalled"], unit: "pct" },
          { key: "b.k_recall_super_active", under: "b.recall_super_active", label: "% of super active leads out of re-attempted answered cold leads", num: "b.recall_super_active", den: ["b.recall_answered"], unit: "pct" },
          { key: "b.k_total_super_active", under: "b.total_super_active", label: "% of total super active cold leads over answered cold leads", num: "b.total_super_active", den: ["b.answered", "b.recall_answered"], unit: "pct" },
        ],
      },
    ],
  },
};

/** Registry metrics a sheet's layout needs (computed per day). */
export function dailyMetrics(sheet: DailySheet): string[] {
  return DAILY_LAYOUT[sheet].sections.flatMap((s) => s.columns.flatMap((c) => (c.kind === "metric" ? [c.metric] : [])));
}

/** Fill the "sum" columns of a row (they can read columns of an earlier section). */
export function applySums(sheet: DailySheet, values: Record<string, number | null>): Record<string, number | null> {
  for (const s of DAILY_LAYOUT[sheet].sections)
    for (const c of s.columns)
      if (c.kind === "sum") values[c.key] = c.of.some((k) => values[k] === null || values[k] === undefined) ? null : c.of.reduce((a, k) => a + (values[k] ?? 0), 0);
  return values;
}

/** A KPI row value from a totals row (percentages to one decimal, averages to two). */
export function kpiValue(k: Extract<DailyKpi, { num: string }>, totals: Record<string, number | null>): number | null {
  const num = totals[k.num];
  const den = k.den.reduce<number>((a, key) => a + (totals[key] ?? 0), 0);
  if (num === null || num === undefined || den === 0) return null;
  return k.unit === "pct" ? Math.round((num / den) * 1000) / 10 : Math.round((num / den) * 100) / 100;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09" → "September 2026". */
export function monthLabel(month: string) {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** "YYYY-MM" for the IST month containing d. */
export function monthKeyOf(d: Date): string {
  const w = new Date(d.getTime() + IST_OFFSET_MS);
  return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}`;
}
