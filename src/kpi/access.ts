import type { PeriodType } from "@prisma/client";
import { SHEETS } from "@/kpi/definitions";
import { hasRole, leaderTeams, type Actor } from "@/lib/rbac";
import { addDays, fromIstInputValue, istDateKey, periodRange } from "@contracts/shared/dates";
import { now } from "@/lib/clock";

/** Leaders, coordinator, admin and data analyst see every sheet and every agent column. */
export function seesAllKpis(a: Actor) {
  return leaderTeams(a).length > 0 || hasRole(a, "admin", "ta_coordinator", "data_analyst");
}
export const canExportKpis = seesAllKpis;

export function visibleSheets(a: Actor) {
  if (seesAllKpis(a)) return SHEETS;
  if (a.kind !== "user") return [];
  return SHEETS.filter((s) => a.roles.some((r) => r.team === s.team && s.roles.includes(r.role)));
}

export function parsePeriod(sp: { period?: string; date?: string }) {
  const periodType: PeriodType = sp.period === "MONTH" ? "MONTH" : "WEEK";
  const anchor = (sp.date && fromIstInputValue(sp.date)) || now();
  const { start, end } = periodRange(periodType, anchor);
  return {
    periodType,
    anchor,
    start,
    end,
    lastDay: addDays(end, -1),
    prevDate: istDateKey(new Date(start.getTime() - 60_000)),
    nextDate: istDateKey(end),
    dateKey: istDateKey(anchor),
  };
}
