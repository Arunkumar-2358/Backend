import ExcelJS from "exceljs";
import type { PeriodType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { formatDate, periodRange, addDays } from "@contracts/shared/dates";
import { redFlagSummary } from "@/modules/redflags/service";
import { SHEETS, metricsFor, type Sheet } from "./definitions";
import { computeSheetTable } from "./engine";

/**
 * "Weekly and monthly Analysis" workbook: one tab per team, metrics as rows in
 * the §6 order, one column per agent plus the team total and target, followed
 * by the "Red flags noticed" and "Action taken" rows.
 */
export async function kpiWorkbook(periodType: PeriodType, anchor: Date, sheets: Sheet[] = SHEETS.map((s) => s.sheet)): Promise<Buffer> {
  const { start, end } = periodRange(periodType, anchor);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Nextenti Recruit CRM";
  const targets = await prisma.kpiTarget.findMany({ where: { periodType } });
  const periodLabel = `${periodType === "WEEK" ? "Weekly" : "Monthly"} analysis · ${formatDate(start)} to ${formatDate(addDays(end, -1))}`;

  for (const s of SHEETS.filter((x) => sheets.includes(x.sheet))) {
    const t = await computeSheetTable(s.sheet, start, end);
    const ws = wb.addWorksheet(s.title.replace(/[\\/*?:[\]]/g, "").slice(0, 31));
    ws.addRow([s.title]).font = { bold: true, size: 13 };
    ws.addRow([periodLabel]).font = { italic: true };
    ws.addRow([]);
    const header = ["S.No", "KPI", ...t.members.map((m) => m.name), "Team total", "Target"];
    const hr = ws.addRow(header);
    hr.font = { bold: true, color: { argb: "FFFFFFFF" } };
    hr.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } }));
    metricsFor(s.sheet).forEach((d, i) => {
      const tgt = targets.find((x) => x.metricKey === d.key && x.teamCode === s.team);
      const cell = (v: number | null | undefined) => (v === null || v === undefined ? "" : d.unit === "pct" ? v / 100 : v);
      const row = ws.addRow([i + 1, d.label, ...t.members.map((m) => cell(m.values[d.key])), cell(t.team[d.key]), tgt ? `${tgt.comparator === "lte" ? "≤" : "≥"} ${tgt.target}${d.unit === "pct" ? "%" : ""}` : ""]);
      if (d.unit === "pct") for (let c = 3; c <= 3 + t.members.length; c++) row.getCell(c).numFmt = "0.0%";
    });
    const flagRowNoticed: string[] = [];
    const flagRowActions: string[] = [];
    for (const m of t.members) {
      const fl = await prisma.redFlag.findMany({ where: { agentId: m.id, raisedOn: { gte: start, lt: end } } });
      flagRowNoticed.push(fl.map((f) => f.description).join("\n"));
      flagRowActions.push(fl.map((f) => f.correctiveActionImplemented ?? f.capaSuggested ?? "").filter(Boolean).join("\n"));
    }
    const teamFlags = await redFlagSummary([s.team], start, end);
    const n = metricsFor(s.sheet).length;
    ws.addRow([n + 1, "Red flags noticed", ...flagRowNoticed, teamFlags.noticed]).alignment = { wrapText: true, vertical: "top" };
    ws.addRow([n + 2, "Action taken", ...flagRowActions, teamFlags.actions]).alignment = { wrapText: true, vertical: "top" };
    ws.getColumn(1).width = 6;
    ws.getColumn(2).width = 42;
    for (let c = 3; c <= header.length; c++) ws.getColumn(c).width = 16;
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: 4 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
