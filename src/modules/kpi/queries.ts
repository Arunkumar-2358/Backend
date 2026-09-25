import type { Prisma } from "@prisma/client";
import type { DashboardView, KpiSheetPage, StageCountMap } from "@contracts";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { addDays, periodRange, startOfIstDay } from "@contracts/shared/dates";
import { hasRole, leaderTeams, leadScope, stagesOwnedBy } from "@/lib/rbac";
import type { UserActor } from "@/http/route";
import { SHEETS } from "@/kpi/definitions";
import { computeSheet, computeSheetTable, sheetMembers } from "@/kpi/engine";
import { canExportKpis, parsePeriod, seesAllKpis, visibleSheets } from "@/kpi/access";
import { chartMetrics, headlineMetrics, sheetMetrics } from "@/kpi/view";
import { redFlagSummary } from "@/modules/redflags/service";

/** The KPI analysis page: one sheet for a week or month, scoped to the caller. */
export async function kpiSheetPage(actor: UserActor, q: { period?: string; date?: string; sheet?: string }): Promise<KpiSheetPage> {
  const p = parsePeriod(q);
  const period = { periodType: p.periodType, start: p.start, end: p.end, lastDay: p.lastDay, prevDate: p.prevDate, nextDate: p.nextDate, dateKey: p.dateKey, isPast: p.end.getTime() <= now().getTime() };
  const sheets = visibleSheets(actor);
  const all = seesAllKpis(actor);
  const empty: KpiSheetPage = { period, sheets: [], sheet: null, seesAll: all, canExport: canExportKpis(actor), table: null, metrics: [], chartMetrics: [], targets: [], snapshotFrozenAt: null, flags: null };
  if (!sheets.length) return empty;

  const meta = sheets.find((s) => s.sheet === q.sheet) ?? sheets[0];
  const sheet = meta.sheet;
  const [table, targets, snapshot, flags] = await Promise.all([
    computeSheetTable(sheet, p.start, p.end, all ? {} : { onlyUserId: actor.id }),
    prisma.kpiTarget.findMany({ where: { periodType: p.periodType, teamCode: meta.team }, select: { metricKey: true, target: true, comparator: true } }),
    prisma.kpiSnapshot.findFirst({ where: { periodType: p.periodType, periodStart: p.start, teamCode: meta.team }, orderBy: { frozenAt: "desc" }, select: { frozenAt: true } }),
    redFlagSummary([meta.team], p.start, p.end),
  ]);
  return {
    ...empty,
    sheets: sheets.map((s) => s.sheet),
    sheet,
    table: { title: table.title, members: table.members, team: table.team },
    metrics: sheetMetrics(sheet),
    chartMetrics: chartMetrics(sheet),
    targets,
    snapshotFrozenAt: snapshot?.frozenAt ?? null,
    flags,
  };
}

async function stageCounts(where: Prisma.CandidateWhereInput): Promise<StageCountMap> {
  const rows = await prisma.candidate.groupBy({ by: ["stage"], where, _count: { _all: true } });
  return Object.fromEntries(rows.map((r) => [r.stage, r._count._all]));
}

/** The role dashboard: own tasks and leads, plus leader / coordinator / data-analyst panels. */
export async function dashboardView(actor: UserActor): Promise<DashboardView> {
  const t = now();
  const dayStart = startOfIstDay(t);
  const dayEnd = addDays(dayStart, 1);
  const lt = leaderTeams(actor);
  const isCoord = hasRole(actor, "admin", "ta_coordinator");
  const isDA = hasRole(actor, "data_analyst");

  const [openTasks, overdueTasks, topTasks, myStages, followupsToday] = await Promise.all([
    prisma.task.count({ where: { assigneeId: actor.id, status: "OPEN" } }),
    prisma.task.count({ where: { assigneeId: actor.id, status: "OPEN", dueAt: { lte: t } } }),
    prisma.task.findMany({ where: { assigneeId: actor.id, status: "OPEN" }, orderBy: { dueAt: "asc" }, take: 5, include: { candidate: { select: { id: true, name: true, candidateCode: true } } } }),
    stageCounts({ AND: [leadScope(actor), { ownerUserId: actor.id }] }),
    prisma.task.findMany({
      where: { assigneeId: actor.id, status: "OPEN", type: { in: ["FOLLOW_UP", "RECALL"] }, dueAt: { gte: dayStart, lt: dayEnd } },
      orderBy: { dueAt: "asc" },
      take: 10,
      include: { candidate: { select: { id: true, name: true, candidateCode: true, stage: true } } },
    }),
  ]);

  // Team leaders: pipeline for owned stages + weekly KPI summary
  const leaderStages = lt.length ? stagesOwnedBy(lt) : [];
  const teamPipeline = lt.length ? { stages: leaderStages, counts: await stageCounts({ stage: { in: leaderStages } }) } : null;
  const week = periodRange("WEEK", t);
  const leaderSheets = SHEETS.filter((s) => lt.includes(s.team));
  const kpiSummaries = await Promise.all(
    leaderSheets.map(async (s) => {
      const ids = (await sheetMembers(s.sheet)).map((m) => m.id);
      const values = await computeSheet(s.sheet, week.start, week.end, ids);
      return { sheet: s.sheet, title: s.title, metrics: headlineMetrics(s.sheet), values };
    }),
  );

  // Coordinator / admin
  const coordinator = isCoord
    ? await Promise.all([
        stageCounts({}),
        prisma.redFlag.count({ where: { status: { not: "CLOSED" } } }),
        prisma.redFlag.count({ where: { status: { in: ["OPEN", "CAPA_SUGGESTED"] }, dueDate: { lt: t } } }),
        prisma.redFlag.findMany({ where: { status: { not: "CLOSED" } }, orderBy: [{ dueDate: "asc" }, { raisedOn: "desc" }], take: 5, include: { agent: { select: { name: true } } } }),
      ]).then(([orgFunnel, openFlags, overdueCapas, recentFlags]) => ({ orgFunnel, openFlags, overdueCapas, recentFlags }))
    : null;

  // Data analyst
  const dataAnalyst = isDA
    ? await Promise.all([
        prisma.candidate.count({ where: { stage: "MAPPING" } }),
        prisma.candidate.findMany({ where: { stage: "MAPPING" }, orderBy: { stageChangedAt: "asc" }, take: 5, select: { id: true, name: true, candidateCode: true, stageChangedAt: true, mainCategory: true } }),
        prisma.importBatch.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
      ]).then(([mappingCount, stuckMapping, batches]) => ({ mappingCount, stuckMapping, batches }))
    : null;

  return { openTasks, overdueTasks, topTasks, followupsToday, myStages, teamPipeline, week: { start: week.start, end: week.end }, kpiSummaries, coordinator, dataAnalyst };
}
