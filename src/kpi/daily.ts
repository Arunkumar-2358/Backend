/**
 * Daily dashboard — the TA team 1 / team 2 monthly workbooks, computed from events.
 * Each day's numbers come from the KPI registry (so they agree with the KPI sheets);
 * week, month and KPI rows follow the workbooks' own formulas: sums of the day rows,
 * then ratios of those sums. Layout: contracts/shared/daily-dashboard.ts.
 */
import ExcelJS from "exceljs";
import type { Prisma, RedFlag } from "@prisma/client";
import type { DailyDashboard, DailyFlag, DailyRow } from "@contracts";
import { prisma, type Tx } from "@/lib/db";
import { now, DAY, HOUR } from "@/lib/clock";
import { ForbiddenError } from "@/lib/rbac";
import { ValidationError } from "@/lib/errors";
import type { UserActor } from "@/platform/endpoint";
import { DAILY_LAYOUT, DAILY_SHEETS, applySums, dailyMetrics, kpiValue, monthKeyOf, monthLabel, type DailyColumn, type DailySheet } from "@contracts/shared/daily-dashboard";

export { monthLabel } from "@contracts/shared/daily-dashboard";
import { fromIstInputValue, periodRange, startOfIstWeek } from "@contracts/shared/dates";
import { SHEETS } from "./definitions";
import { computeSheet, sheetMembers } from "./engine";
import { seesAllKpis, canExportKpis, visibleSheets } from "./access";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Days computed at once (each runs a handful of count queries). */
const DAY_BATCH = 6;

export function monthRange(month: string) {
  return periodRange("MONTH", fromIstInputValue(`${month}-01`)!);
}

function shiftMonth(month: string, by: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Monday–Sunday weeks, clipped to the month — the workbooks' "Week 1 … Week 5". */
function weeksOf(start: Date, end: Date) {
  const out: { start: Date; end: Date }[] = [];
  for (let s = start; s < end; ) {
    const e = new Date(Math.min(startOfIstWeek(s).getTime() + 7 * DAY, end.getTime()));
    out.push({ start: s, end: e });
    s = e;
  }
  return out;
}

const numericColumns = (sheet: DailySheet) =>
  DAILY_LAYOUT[sheet].sections.flatMap((s) => s.columns).filter((c): c is Extract<DailyColumn, { kind: "metric" | "sum" }> => c.kind === "metric" || c.kind === "sum");

const flagOf = (f: RedFlag): DailyFlag => ({
  description: f.description,
  action: f.capaSuggested,
  status: f.status,
  tatHours: f.closedAt ? Math.round((f.closedAt.getTime() - f.raisedOn.getTime()) / HOUR) : null,
});

type Built = Pick<DailyDashboard, "days" | "weeks" | "total" | "kpis">;

/**
 * One person's (or the whole team's) month. `teamFlags`: include team-level red flags
 * (no agent) — the consolidated view; a person's view shows the flags raised against them.
 */
export async function buildDaily(sheet: DailySheet, month: string, userIds: string[], opts: { teamFlags: boolean }, db: Tx = prisma): Promise<Built> {
  const { start, end } = monthRange(month);
  const t = now();
  const team = SHEETS.find((s) => s.sheet === sheet)!.team;
  const metrics = dailyMetrics(sheet);
  const numeric = numericColumns(sheet);
  const dayStarts = Array.from({ length: Math.round((end.getTime() - start.getTime()) / DAY) }, (_, i) => new Date(start.getTime() + i * DAY));

  const perDay: (Record<string, number | null> | null)[] = [];
  for (let i = 0; i < dayStarts.length; i += DAY_BATCH) {
    perDay.push(
      ...(await Promise.all(dayStarts.slice(i, i + DAY_BATCH).map((d) => (d > t ? null : computeSheet(sheet, d, new Date(d.getTime() + DAY), userIds, db, metrics))))),
    );
  }

  const flagScope: Prisma.RedFlagWhereInput = opts.teamFlags ? {} : { agentId: { in: userIds } };
  const [postings, raised, closed] = await Promise.all([
    db.vacancy.findMany({
      where: { postedAt: { gte: start, lt: end }, [sheet === "T1A" ? "taLeadId" : "sourcerId"]: { in: userIds } },
      select: { code: true, title: true, description: true, mandatoryAttributes: true, postedAt: true },
      orderBy: { postedAt: "asc" },
    }),
    db.redFlag.findMany({ where: { teamCode: team, raisedOn: { gte: start, lt: end }, ...flagScope }, orderBy: { raisedOn: "asc" } }),
    db.redFlag.findMany({ where: { teamCode: team, closedAt: { gte: start, lt: end }, ...flagScope } }),
  ]);
  const within = (d: Date, s: Date, e: Date) => d >= s && d < e;

  const days: DailyRow[] = dayStarts.map((d, i) => {
    const e = new Date(d.getTime() + DAY);
    const v = perDay[i];
    const values: Record<string, number | null> = {};
    for (const c of numeric) if (c.kind === "metric") values[c.key] = v ? v[c.metric] ?? 0 : null;
    const dayFlags = raised.filter((f) => within(f.raisedOn, d, e));
    return {
      label: String(i + 1),
      kind: "day",
      start: d,
      end: e,
      future: !v,
      values: applySums(sheet, values),
      postings: postings.filter((p) => within(p.postedAt, d, e)).map(({ postedAt: _postedAt, ...p }) => p),
      flags: dayFlags.map(flagOf),
      flagCount: dayFlags.length,
    };
  });

  const aggregate = (label: string, kind: "week" | "month", s: Date, e: Date): DailyRow => {
    const inside = days.filter((d) => within(d.start, s, e) && !d.future);
    const values: Record<string, number | null> = {};
    for (const c of numeric) values[c.key] = inside.length ? inside.reduce((a, d) => a + (d.values[c.key] ?? 0), 0) : null;
    return { label, kind, start: s, end: e, future: !inside.length, values, postings: [], flags: [], flagCount: raised.filter((f) => within(f.raisedOn, s, e)).length };
  };
  const weeks = weeksOf(start, end).map((w, i) => aggregate(`Week ${i + 1}`, "week", w.start, w.end));
  const total = aggregate("Total", "month", start, end);

  const kpiRow = (row: DailyRow, label: string) => {
    const values: Record<string, number | null> = {};
    const closedIn = closed.filter((f) => within(f.closedAt!, row.start, row.end));
    for (const s of DAILY_LAYOUT[sheet].sections)
      for (const k of s.kpis) {
        if ("num" in k) values[k.key] = row.future ? null : kpiValue(k, row.values);
        else if (k.flags === "new") values[k.key] = row.flagCount;
        else if (k.flags === "closed") values[k.key] = closedIn.length;
        else values[k.key] = Math.round((closedIn.reduce((a, f) => a + (f.closedAt!.getTime() - f.raisedOn.getTime()), 0) / DAY) * 10) / 10;
      }
    return { label, values };
  };

  return { days, weeks, total, kpis: [...weeks.map((w) => kpiRow(w, w.label)), kpiRow(total, "Monthly")] };
}

function dailySheetsFor(actor: UserActor) {
  const all = seesAllKpis(actor);
  return DAILY_SHEETS.filter((s) => all || visibleSheets(actor).some((v) => v.sheet === s));
}

/** The dashboard page: a person's month, or the consolidated team month for those who see every KPI. */
export async function getDailyDashboard(actor: UserActor, q: { sheet?: string; month?: string; user?: string }): Promise<DailyDashboard> {
  const sheets = dailySheetsFor(actor);
  if (!sheets.length) throw new ForbiddenError("The daily dashboard covers TA teams 1 and 2");
  const sheet = sheets.includes(q.sheet as DailySheet) ? (q.sheet as DailySheet) : sheets[0];
  const month = q.month && MONTH.test(q.month) ? q.month : monthKeyOf(now());
  const all = seesAllKpis(actor);
  const members = (await sheetMembers(sheet)).map((m) => ({ id: m.id, name: m.active ? m.name : `${m.name} (inactive)` }));

  let subject: { id: string; name: string } | null;
  if (all) {
    subject = !q.user || q.user === "team" ? null : members.find((m) => m.id === q.user) ?? null;
    if (q.user && q.user !== "team" && !subject) throw new ValidationError("That person is not on this team");
  } else {
    subject = members.find((m) => m.id === actor.id) ?? null;
    if (!subject) throw new ForbiddenError("You can only see your own daily dashboard");
  }

  const built = await buildDaily(sheet, month, subject ? [subject.id] : members.map((m) => m.id), { teamFlags: !subject });
  return {
    sheet,
    month,
    prevMonth: shiftMonth(month, -1),
    nextMonth: shiftMonth(month, 1),
    subject,
    sheets,
    members: all ? members : members.filter((m) => m.id === actor.id),
    seesAll: all,
    canExport: canExportKpis(actor),
    ...built,
  };
}

// ───────────── Excel export (the workbook layout: one tab per person + Consolidated) ─────────────

const FLAG_HEADERS = ["Any red flags on this day", "Action suggested for the red flag", "Red flag closed / open", "TAT for the closure of red flag"];
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
const TITLE_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF548235" } };

const tat = (h: number | null) => (h === null ? "" : h < 48 ? `${h} hrs` : `${Math.round((h / 24) * 10) / 10} days`);

function writeTab(wb: ExcelJS.Workbook, sheet: DailySheet, month: string, name: string, b: Built) {
  const layout = DAILY_LAYOUT[sheet];
  const ws = wb.addWorksheet(name.replace(/[\\/*?:[\]]/g, "").slice(0, 31));
  ws.getCell(1, 1).value = `${layout.title} · ${name} · ${monthLabel(month)} (computed by Nextenti Recruit CRM)`;
  ws.getCell(1, 1).font = { bold: true, size: 12 };

  // Column positions: each section starts with its own Date column, as in the workbooks.
  const colOf: Record<string, number> = {};
  const flagCol: Record<string, number> = {};
  const dateCols: number[] = [];
  let col = 1;
  for (const s of layout.sections) {
    const title = ws.getCell(2, col);
    title.value = s.title;
    title.font = { bold: true, color: { argb: "FFFFFFFF" } };
    title.fill = TITLE_FILL;
    dateCols.push(col);
    ws.getCell(3, col).value = "Date";
    col++;
    for (const c of s.columns) {
      if (c.kind === "flags") {
        flagCol[c.key] = col;
        FLAG_HEADERS.forEach((h, i) => (ws.getCell(3, col + i).value = h));
        col += FLAG_HEADERS.length;
      } else {
        colOf[c.key] = col;
        ws.getCell(3, col).value = c.label;
        col++;
      }
    }
  }
  const header = ws.getRow(3);
  header.font = { bold: true };
  header.alignment = { wrapText: true, vertical: "top" };
  header.height = 75;
  for (let c = 1; c < col; c++) {
    ws.getCell(3, c).fill = HEADER_FILL;
    ws.getColumn(c).width = dateCols.includes(c) ? 9 : 18;
  }

  const writeRow = (r: number, row: DailyRow, label: string) => {
    for (const dc of dateCols) ws.getCell(r, dc).value = label;
    for (const s of layout.sections)
      for (const c of s.columns) {
        if (c.kind === "flags") {
          const at = flagCol[c.key];
          if (row.kind === "day") {
            ws.getCell(r, at).value = row.flags.map((f) => f.description).join("\n");
            ws.getCell(r, at + 1).value = row.flags.map((f) => f.action ?? "").join("\n");
            ws.getCell(r, at + 2).value = row.flags.map((f) => (f.status === "CLOSED" ? "closed" : "open")).join("\n");
            ws.getCell(r, at + 3).value = row.flags.map((f) => tat(f.tatHours)).join("\n");
          } else if (!row.future) ws.getCell(r, at).value = row.flagCount;
        } else if (c.kind === "postings") {
          ws.getCell(r, colOf[c.key]).value = row.postings.map((p) => `${p.code} ${p.title}${p[c.field] ? `: ${p[c.field]}` : ""}`).join("\n");
        } else if (!row.future && row.values[c.key] !== null) ws.getCell(r, colOf[c.key]).value = row.values[c.key];
      }
    ws.getRow(r).alignment = { wrapText: true, vertical: "top" };
  };

  let r = 4;
  for (const d of b.days) writeRow(r++, d, d.label);
  writeRow(r, b.total, "Total");
  ws.getRow(r++).font = { bold: true };
  r++;
  for (const w of b.weeks) writeRow(r++, w, w.label);
  writeRow(r, b.total, "Monthly");
  ws.getRow(r++).font = { bold: true };

  // KPI header, then one row per week and the month.
  const kpiHeader = r++;
  for (const dc of dateCols) ws.getCell(kpiHeader, dc).value = "KPI";
  const kpiCol = (k: (typeof layout.sections)[number]["kpis"][number]) =>
    "num" in k ? colOf[k.under] : flagCol[k.under] + (k.flags === "new" ? 0 : k.flags === "closed" ? 2 : 3);
  for (const s of layout.sections) for (const k of s.kpis) ws.getCell(kpiHeader, kpiCol(k)).value = k.label;
  ws.getRow(kpiHeader).font = { bold: true };
  ws.getRow(kpiHeader).alignment = { wrapText: true, vertical: "top" };
  ws.getRow(kpiHeader).height = 60;
  for (const k of b.kpis) {
    for (const dc of dateCols) ws.getCell(r, dc).value = k.label;
    for (const s of layout.sections)
      for (const def of s.kpis) {
        const v = k.values[def.key];
        if (v === null || v === undefined) continue;
        const cell = ws.getCell(r, kpiCol(def));
        cell.value = v;
        if ("num" in def) cell.numFmt = def.unit === "pct" ? '0.0"%"' : "0.00";
      }
    r++;
  }
  ws.views = [{ state: "frozen", ySplit: 3, xSplit: 1 }];
}

/** The month for every person on the sheet (a tab each) plus Consolidated. */
export async function dailyWorkbook(sheet: DailySheet, month: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Nextenti Recruit CRM";
  const members = await sheetMembers(sheet);
  for (const m of members) writeTab(wb, sheet, month, m.name, await buildDaily(sheet, month, [m.id], { teamFlags: false }));
  writeTab(wb, sheet, month, "Consolidated", await buildDaily(sheet, month, members.map((m) => m.id), { teamFlags: true }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function parseDailyExport(q: { sheet?: string; month?: string }) {
  const sheet = DAILY_SHEETS.includes(q.sheet as DailySheet) ? (q.sheet as DailySheet) : null;
  if (!sheet) throw new ValidationError("Choose TA team 1 or team 2");
  const month = q.month && MONTH.test(q.month) ? q.month : monthKeyOf(now());
  return { sheet, month };
}
