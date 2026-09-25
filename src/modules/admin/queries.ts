/** Read models for the Admin pages (formerly inline Prisma queries in the web pages). */
import { TeamCode, type DeletionRequestStatus, type JobStatus, type Prisma } from "@prisma/client";
import type { AdminAttendancePage, AdminAuditPage, AdminAuditQuery, AdminDeletionsPage, AdminJobsPage, AdminKpiMetric, AdminRulesPage, AdminSettingsPage, AdminTargetsPage, AdminUsersPage } from "@contracts";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { DEFAULT_SETTINGS, getAllSettings } from "@/lib/settings";
import { KPI_BY_KEY, KPI_DEFINITIONS, type KpiDef } from "@/kpi/definitions";
import { addDays, fromIstInputValue, istDateKey, startOfIstWeek } from "@contracts/shared/dates";
import { TARGETABLE_UNITS, utcDay } from "./helpers";

export const PAGE_SIZE = 50;

const JOB_STATUSES: JobStatus[] = ["PENDING", "FAILED", "DONE", "CANCELLED"];

export async function usersPage(): Promise<AdminUsersPage> {
  const [users, teams] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      omit: { passwordHash: true },
      include: { roles: { include: { team: true }, orderBy: { team: { code: "asc" } } } },
    }),
    prisma.team.findMany({ orderBy: { code: "asc" } }),
  ]);
  return { users, teams };
}

export async function rulesPage(): Promise<AdminRulesPage> {
  const [rules, users, teams] = await Promise.all([
    prisma.assignmentRule.findMany({ orderBy: [{ teamCode: "asc" }, { category: "asc" }, { priority: "desc" }], include: { user: { select: { name: true, active: true } } } }),
    prisma.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.team.findMany({ orderBy: { code: "asc" } }),
  ]);
  return { rules, users, teams };
}

export function templatesPage() {
  return prisma.messageTemplate.findMany({ orderBy: [{ key: "asc" }] });
}

export async function settingsPage(): Promise<AdminSettingsPage> {
  return { values: { ...(await getAllSettings()) }, defaults: { ...DEFAULT_SETTINGS } };
}

export function holidaysPage() {
  return prisma.holiday.findMany({ orderBy: { date: "asc" } });
}

const metricOf = (d: KpiDef): AdminKpiMetric => ({ key: d.key, label: d.label, description: d.description, sheet: d.sheet, unit: d.unit });

export async function targetsPage(sheet?: string): Promise<AdminTargetsPage> {
  const targets = await prisma.kpiTarget.findMany({ orderBy: [{ teamCode: "asc" }, { metricKey: "asc" }, { periodType: "asc" }] });
  return {
    targets: targets
      .filter((t) => !sheet || KPI_BY_KEY[t.metricKey]?.sheet === sheet)
      .map((t) => ({ ...t, metric: KPI_BY_KEY[t.metricKey] ? metricOf(KPI_BY_KEY[t.metricKey]) : null })),
    metrics: KPI_DEFINITIONS.filter((d) => TARGETABLE_UNITS.includes(d.unit) && (!sheet || d.sheet === sheet)).map(metricOf),
  };
}

export async function attendancePage(q: { week?: string; team?: string }): Promise<AdminAttendancePage> {
  const anchor = (q.week && fromIstInputValue(q.week)) || now();
  const monday = startOfIstWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => istDateKey(addDays(monday, i)));
  const team = (Object.values(TeamCode) as string[]).includes(q.team ?? "") ? (q.team as TeamCode) : null;
  const [users, rows, teams] = await Promise.all([
    prisma.user.findMany({
      where: { active: true, roles: { some: team ? { team: { code: team } } : { role: { not: "admin" } } } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, roles: { select: { team: { select: { code: true } } } } },
    }),
    prisma.attendance.findMany({ where: { date: { gte: utcDay(days[0]), lte: utcDay(days[6]) } } }),
    prisma.team.findMany({ orderBy: { code: "asc" } }),
  ]);
  const key = (r: { userId: string; date: Date }) => `${r.userId}|${r.date.toISOString().slice(0, 10)}`;
  return {
    monday,
    days,
    team,
    teams,
    users: users.map((u) => ({ id: u.id, name: u.name, teamCodes: [...new Set(u.roles.map((r) => r.team.code))] })),
    present: rows.filter((r) => r.present).map(key),
    recorded: rows.map(key),
  };
}

export async function deletionsPage(q: { status?: DeletionRequestStatus; page?: number }): Promise<AdminDeletionsPage> {
  const page = Math.max(1, q.page ?? 1);
  const where = q.status ? { status: q.status } : {};
  const [total, rows] = await Promise.all([
    prisma.dataDeletionRequest.count({ where }),
    prisma.dataDeletionRequest.findMany({
      where,
      orderBy: [{ status: "asc" }, { requestedAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { candidate: { select: { id: true, name: true, candidateCode: true, anonymizedAt: true } } },
    }),
  ]);
  const userIds = [...new Set(rows.map((r) => r.processedById).filter((x): x is string => !!x))];
  const users = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return { total, page, pageSize: PAGE_SIZE, rows: rows.map((r) => ({ ...r, processedByName: users.get(r.processedById ?? "") ?? null })) };
}

export async function auditPage(sp: AdminAuditQuery): Promise<AdminAuditPage> {
  const page = Math.max(1, sp.page ?? 1);
  const from = sp.from ? fromIstInputValue(sp.from) : null;
  const to = sp.to ? fromIstInputValue(sp.to) : null;
  const where: Prisma.AuditLogWhereInput = {
    ...(sp.action ? { action: sp.action } : {}),
    ...(sp.entityType ? { entityType: sp.entityType } : {}),
    ...(sp.entityId ? { entityId: sp.entityId.trim() } : {}),
    ...(sp.actor ? (sp.actor.startsWith("system") ? { actorId: null, actorLabel: { contains: sp.actor.replace(/^system:?/, "") } } : { actorId: sp.actor }) : {}),
    ...(from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lt: addDays(to, 1) } : {}) } } : {}),
  };
  const [total, rows, entityTypes, users] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { at: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    prisma.auditLog.findMany({ distinct: ["entityType"], select: { entityType: true }, orderBy: { entityType: "asc" } }),
    prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return { total, page, pageSize: PAGE_SIZE, rows, entityTypes: entityTypes.map((e) => e.entityType), users };
}

export async function jobsPage(q: { status?: JobStatus; type?: string; page?: number }): Promise<AdminJobsPage> {
  const status = q.status;
  const page = Math.max(1, q.page ?? 1);
  const where: Prisma.ScheduledJobWhereInput = { ...(status ? { status } : {}), ...(q.type ? { type: q.type } : {}) };
  const [counts, due, total, jobs, types, lastFreeze] = await Promise.all([
    prisma.scheduledJob.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.scheduledJob.count({ where: { status: "PENDING", runAt: { lte: now() } } }),
    prisma.scheduledJob.count({ where }),
    prisma.scheduledJob.findMany({ where, orderBy: status === "DONE" ? { doneAt: "desc" } : { runAt: "asc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    prisma.scheduledJob.findMany({ distinct: ["type"], select: { type: true }, orderBy: { type: "asc" } }),
    prisma.kpiSnapshot.findFirst({ orderBy: { frozenAt: "desc" } }),
  ]);
  return {
    counts: Object.fromEntries(JOB_STATUSES.map((s) => [s, counts.find((c) => c.status === s)?._count._all ?? 0])) as Record<JobStatus, number>,
    due,
    total,
    page,
    pageSize: PAGE_SIZE,
    jobs,
    types: types.map((t) => t.type),
    lastFreezeAt: lastFreeze?.frozenAt ?? null,
  };
}
