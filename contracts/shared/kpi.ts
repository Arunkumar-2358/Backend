/** KPI sheet metadata and value formatting. Metric formulas live in the API. */
import type { TeamCode } from "../models";

export type Sheet = "T1A" | "T1B" | "T2" | "T3A" | "T3B" | "T3C" | "T4_DA" | "T4_COORD";

export const SHEETS: { sheet: Sheet; team: TeamCode; title: string; roles: string[] }[] = [
  { sheet: "T1A", team: "T1A", title: "Team 1a – TA Leads", roles: ["ta_lead"] },
  { sheet: "T1B", team: "T1B", title: "Team 1b – Communication centre", roles: ["telecaller"] },
  { sheet: "T2", team: "T2", title: "Team 2 – Talent Sourcers", roles: ["sourcer"] },
  { sheet: "T3A", team: "T3A", title: "Team 3a – Recruitment (general)", roles: ["recruiter"] },
  { sheet: "T3B", team: "T3B", title: "Team 3b – Recruitment (existing clients)", roles: ["recruiter"] },
  { sheet: "T3C", team: "T3C", title: "Team 3c – Recruitment (free-trial orgs)", roles: ["recruiter"] },
  { sheet: "T4_DA", team: "T4", title: "Team 4 – Data analyst", roles: ["data_analyst"] },
  { sheet: "T4_COORD", team: "T4", title: "Team 4 – TA coordinator", roles: ["ta_coordinator"] },
];

export type Unit = "count" | "pct" | "minutes" | "ratio" | "avg";

export function formatKpi(v: number | null, unit: Unit): string {
  if (v === null || v === undefined) return "–";
  if (unit === "pct") return `${v}%`;
  if (unit === "minutes") return `${v} min`;
  return String(v);
}
