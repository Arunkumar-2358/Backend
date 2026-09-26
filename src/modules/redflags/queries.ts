import type { Prisma, RedFlag, RedFlagStatus, TeamCode } from "@prisma/client";
import type { RaiseRedFlagOptions, RedFlagDetail, RedFlagList } from "@contracts";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { getSetting } from "@/lib/settings";
import { addWorkingDays, istDateKey, periodRange } from "@contracts/shared/dates";
import { canManageRedFlags, leaderTeams, ForbiddenError, type Actor } from "@/lib/rbac";
import { notFound } from "@/lib/http-errors";
import type { UserActor } from "@/platform/endpoint";
import { SHEETS, formatKpi, metricsFor } from "@/kpi/definitions";
import { holidaySet } from "./service";

export const PAGE_SIZE = 25;
export const TEAM_CODES: TeamCode[] = ["T1A", "T1B", "T2", "T3A", "T3B", "T3C", "T4"];
const STATUSES: RedFlagStatus[] = ["OPEN", "CAPA_SUGGESTED", "IMPLEMENTED", "CLOSED"];

/** Coordinator/admin: all flags. Leaders: their teams' flags. Anyone: flags they own the action for. */
export function redFlagScope(a: Actor): Prisma.RedFlagWhereInput {
  if (canManageRedFlags(a)) return {};
  if (a.kind !== "user") return {};
  const lt = leaderTeams(a);
  return { OR: [{ actionOwnerId: a.id }, ...(lt.length ? [{ teamCode: { in: lt } }] : [])] };
}

export function canViewRedFlag(a: Actor, f: Pick<RedFlag, "teamCode" | "actionOwnerId">) {
  if (canManageRedFlags(a)) return true;
  if (a.kind !== "user") return false;
  return f.actionOwnerId === a.id || leaderTeams(a).includes(f.teamCode);
}

function periodFilter(p: string | undefined): { gte: Date; lt: Date } | undefined {
  if (!p) return undefined;
  const kind = p.endsWith("month") ? "MONTH" : "WEEK";
  const cur = periodRange(kind, now());
  const r = p.startsWith("last") ? periodRange(kind, new Date(cur.start.getTime() - 60_000)) : cur;
  return { gte: r.start, lt: r.end };
}

export type RedFlagListQuery = { team?: string; status?: string; source?: string; period?: string; page?: number };

export async function listRedFlags(actor: UserActor, q: RedFlagListQuery): Promise<RedFlagList> {
  const manage = canManageRedFlags(actor);
  const page = Math.max(1, q.page || 1);
  const range = periodFilter(q.period);
  const where: Prisma.RedFlagWhereInput = {
    AND: [
      redFlagScope(actor),
      {
        ...(q.team && TEAM_CODES.includes(q.team as TeamCode) ? { teamCode: q.team as TeamCode } : {}),
        ...(q.status === "NOT_CLOSED" ? { status: { not: "CLOSED" } } : q.status && STATUSES.includes(q.status as RedFlagStatus) ? { status: q.status as RedFlagStatus } : {}),
        ...(q.source === "auto" ? { autoRaised: true } : q.source === "manual" ? { autoRaised: false } : {}),
        ...(range ? { raisedOn: range } : {}),
      },
    ],
  };
  const [total, flags, teams] = await Promise.all([
    prisma.redFlag.count({ where }),
    prisma.redFlag.findMany({
      where,
      orderBy: [{ raisedOn: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { agent: { select: { name: true } }, actionOwner: { select: { name: true } } },
    }),
    prisma.team.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true } }),
  ]);

  let raise: RaiseRedFlagOptions | null = null;
  if (manage) {
    const [users, targets] = await Promise.all([
      prisma.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, roles: { select: { team: { select: { code: true } } } } } }),
      prisma.kpiTarget.findMany({ where: { periodType: "WEEK" } }),
    ]);
    raise = {
      teams: teams.map((t) => ({ code: t.code, name: t.name })),
      members: users.map((u) => ({ id: u.id, name: u.name, teams: [...new Set(u.roles.map((r) => r.team.code))] })),
      kpis: SHEETS.flatMap((s) =>
        metricsFor(s.sheet).map((d) => {
          const t = targets.find((x) => x.metricKey === d.key && x.teamCode === s.team);
          return { key: d.key, label: d.label, team: s.team, sheetTitle: s.title, target: t ? `${t.comparator === "lte" ? "≤" : "≥"} ${formatKpi(t.target, d.unit)}` : undefined };
        }),
      ),
    };
  }
  return { manage, page, pageSize: PAGE_SIZE, total, flags, teams, raise };
}

export async function redFlagDetail(actor: UserActor, id: string): Promise<RedFlagDetail> {
  const f = await prisma.redFlag.findUnique({
    where: { id },
    include: { agent: { select: { name: true } }, actionOwner: { select: { id: true, name: true } }, raisedBy: { select: { name: true } } },
  });
  if (!f) throw notFound("Red flag not found");
  if (!canViewRedFlag(actor, f)) throw new ForbiddenError("You cannot view this red flag");

  const manage = canManageRedFlags(actor);
  const [sla, holidays] = await Promise.all([getSetting("redFlagSlaWorkingDays"), holidaySet()]);
  const users = manage ? await prisma.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];
  return {
    flag: f,
    manage,
    isOwner: f.actionOwnerId === actor.id,
    sla,
    slaDeadline: addWorkingDays(f.raisedOn, sla, holidays),
    todayIsHoliday: holidays.has(istDateKey(now())),
    users,
  };
}
