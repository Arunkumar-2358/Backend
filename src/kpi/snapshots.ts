import type { PeriodType } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { now } from "@/lib/clock";
import { addWorkingDays, formatDate, periodRange } from "@contracts/shared/dates";
import { SYSTEM } from "@/lib/rbac";
import { raiseRedFlag, holidaySet } from "@/modules/redflags/service";
import { KPI_BY_KEY, SHEETS, formatKpi, type Sheet } from "./definitions";
import { computeSheetTable } from "./engine";

/** Freeze a period's KPIs into kpi_snapshots (per agent + team total). */
export async function freezePeriod(periodType: PeriodType, anchor: Date, db: Tx = prisma) {
  const { start, end } = periodRange(periodType, anchor);
  let rows = 0;
  for (const s of SHEETS) {
    const t = await computeSheetTable(s.sheet, start, end, {}, db);
    const write = async (userId: string | null, values: Record<string, number | null>) => {
      for (const [metricKey, value] of Object.entries(values)) {
        if (value === null) continue;
        const existing = await db.kpiSnapshot.findFirst({ where: { teamCode: s.team, userId, periodType, periodStart: start, metricKey } });
        if (existing) await db.kpiSnapshot.update({ where: { id: existing.id }, data: { value, frozenAt: now() } });
        else await db.kpiSnapshot.create({ data: { teamCode: s.team, userId, periodType, periodStart: start, metricKey, value, frozenAt: now() } });
        rows++;
      }
    };
    for (const m of t.members) await write(m.id, m.values);
    await write(null, t.team);
  }
  const flags = await evaluateTargets(periodType, anchor, db);
  return { start, end, rows, flags };
}

/**
 * Automatic red flags (M7): compare each agent's value to the configured
 * target for their team; raise one flag per (metric, agent, period).
 */
export async function evaluateTargets(periodType: PeriodType, anchor: Date, db: Tx = prisma) {
  const { start, end } = periodRange(periodType, anchor);
  const targets = await db.kpiTarget.findMany({ where: { periodType } });
  if (!targets.length) return 0;
  const holidays = await holidaySet(db);
  let raised = 0;
  const bySheet = new Map<Sheet, typeof targets>();
  for (const t of targets) {
    const def = KPI_BY_KEY[t.metricKey];
    if (!def) continue;
    bySheet.set(def.sheet, [...(bySheet.get(def.sheet) ?? []), t]);
  }
  for (const [sheet, ts] of bySheet) {
    const table = await computeSheetTable(sheet, start, end, {}, db);
    const subjects = table.members.length && !KPI_BY_KEY[ts[0].metricKey].teamOnly ? table.members : [{ id: null as string | null, name: "Team", values: table.team }];
    for (const t of ts) {
      const def = KPI_BY_KEY[t.metricKey];
      for (const subj of subjects) {
        const v = subj.values[t.metricKey];
        if (v === null || v === undefined) continue; // not applicable (no base activity)
        const missed = t.comparator === "lte" ? v > t.target : v < t.target;
        if (!missed) continue;
        await raiseRedFlag(SYSTEM("kpi-targets"), {
          teamCode: t.teamCode,
          agentId: subj.id,
          description: `${def.label} ${formatKpi(v, def.unit)} vs target ${t.comparator === "lte" ? "≤" : "≥"} ${formatKpi(t.target, def.unit)} (${periodType === "WEEK" ? "week" : "month"} from ${formatDate(start)})`,
          kpiKey: t.metricKey,
          kpiDeviated: def.label,
          targetStandard: `${t.comparator === "lte" ? "≤" : "≥"} ${formatKpi(t.target, def.unit)}`,
          actual: formatKpi(v, def.unit),
          date: end,
          dueDate: addWorkingDays(now(), 1, holidays),
          autoRaised: true,
          periodType,
          periodStart: start,
          dedupeKey: `${t.metricKey}:${subj.id ?? "team"}:${periodType}:${start.toISOString()}`,
        }, db);
        raised++;
      }
    }
  }
  return raised;
}

/** Freeze the last completed week and month if they have not been frozen yet. */
export async function freezeDuePeriods(db: Tx = prisma) {
  const out: string[] = [];
  for (const pt of ["WEEK", "MONTH"] as const) {
    const current = periodRange(pt, now());
    const prevAnchor = new Date(current.start.getTime() - 60_000);
    const prev = periodRange(pt, prevAnchor);
    const done = await db.kpiSnapshot.findFirst({ where: { periodType: pt, periodStart: prev.start } });
    if (!done) {
      const r = await freezePeriod(pt, prevAnchor, db);
      out.push(`${pt} ${formatDate(prev.start)}: ${r.rows} rows, ${r.flags} flags`);
    }
  }
  return out.join("; ") || "nothing due";
}
