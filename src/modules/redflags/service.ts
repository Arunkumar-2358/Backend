import type { PeriodType, TeamCode } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { now } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { getSetting } from "@/lib/settings";
import { addWorkingDays, istDateKey, formatDate } from "@contracts/shared/dates";
import { notify, usersWithRole } from "@/modules/notifications/service";
import { ValidationError } from "@/lib/errors";
import { type Actor, ForbiddenError, actorId, canManageRedFlags } from "@/lib/rbac";

export async function holidaySet(db: Tx = prisma): Promise<Set<string>> {
  const rows = await db.holiday.findMany();
  return new Set(rows.map((h) => h.date.toISOString().slice(0, 10)));
}

/** Closed within N working day(s) of being raised (Sundays + holiday calendar excluded). */
export function withinWorkingDays(raisedOn: Date, closedAt: Date, n: number, holidays: Set<string>): boolean {
  return closedAt.getTime() <= addWorkingDays(raisedOn, n, holidays).getTime();
}

export type RedFlagInput = {
  teamCode: TeamCode;
  description: string;
  agentId?: string | null;
  kpiKey?: string | null;
  kpiDeviated?: string | null;
  targetStandard?: string | null;
  actual?: string | null;
  date?: Date;
  dueDate?: Date | null;
  actionOwnerId?: string | null;
};

export async function raiseRedFlag(actor: Actor, input: RedFlagInput & { autoRaised?: boolean; periodType?: PeriodType; periodStart?: Date; dedupeKey?: string }, db: Tx = prisma) {
  if (!canManageRedFlags(actor)) throw new ForbiddenError("Only the TA coordinator or admin can raise red flags");
  if (input.dedupeKey) {
    const existing = await db.redFlag.findUnique({ where: { dedupeKey: input.dedupeKey } });
    if (existing) return existing;
  }
  const f = await db.redFlag.create({
    data: { ...input, date: input.date ?? now(), raisedOn: now(), raisedById: actorId(actor), status: "OPEN" },
  });
  await audit(actor, "RED_FLAG", "red_flag", f.id, { action: "raised", ...input }, db);
  const leaderRole = input.teamCode.startsWith("T1") ? "team1_leader" : input.teamCode === "T2" ? "team2_leader" : input.teamCode.startsWith("T3") ? "team3_leader" : "admin";
  const recipients = [input.agentId, ...(await usersWithRole([leaderRole], undefined, db)), ...(input.autoRaised ? await usersWithRole(["ta_coordinator"], undefined, db) : [])];
  await notify(recipients, { kind: "RED_FLAG", title: `${input.autoRaised ? "Auto red flag" : "Red flag"} · Team ${input.teamCode.slice(1)}`, body: input.description, link: `/red-flags/${f.id}` }, db, actor);
  return f;
}

export async function suggestCapa(actor: Actor, id: string, input: { capaSuggested: string; expectedOutcome?: string; dueDate?: Date | null; actionOwnerId?: string | null }, db: Tx = prisma) {
  if (!canManageRedFlags(actor)) throw new ForbiddenError("Only the TA coordinator suggests CAPA");
  const f = await db.redFlag.findUniqueOrThrow({ where: { id } });
  if (f.status === "CLOSED") throw new ValidationError("Red flag is closed");
  const u = await db.redFlag.update({ where: { id }, data: { ...input, capaSuggestedAt: now(), status: "CAPA_SUGGESTED" } });
  await audit(actor, "RED_FLAG", "red_flag", id, { action: "capa_suggested", ...input }, db);
  await notify(input.actionOwnerId ?? f.actionOwnerId, { kind: "CAPA", title: "CAPA assigned to you", body: `${input.capaSuggested}${input.dueDate ? ` · due ${formatDate(input.dueDate)}` : ""}`, link: `/red-flags/${id}` }, db, actor);
  return u;
}

export async function implementCapa(actor: Actor, id: string, input: { correctiveActionImplemented: string; achievedOutcome?: string }, db: Tx = prisma) {
  const f = await db.redFlag.findUniqueOrThrow({ where: { id } });
  if (!canManageRedFlags(actor) && actorId(actor) !== f.actionOwnerId) throw new ForbiddenError("Only the action owner records the corrective action");
  if (f.status !== "CAPA_SUGGESTED") throw new ValidationError("CAPA must be suggested first");
  const u = await db.redFlag.update({ where: { id }, data: { ...input, implementedAt: now(), completionDate: now(), status: "IMPLEMENTED" } });
  await audit(actor, "RED_FLAG", "red_flag", id, { action: "implemented", ...input }, db);
  await notify([f.raisedById, ...(await usersWithRole(["ta_coordinator"], undefined, db))], { kind: "CAPA", title: "Corrective action ready to verify", body: input.correctiveActionImplemented, link: `/red-flags/${id}` }, db, actor);
  return u;
}

export async function verifyAndClose(actor: Actor, id: string, achievedOutcome: string | undefined, db: Tx = prisma) {
  if (!canManageRedFlags(actor)) throw new ForbiddenError("Only the TA coordinator verifies and closes red flags");
  const f = await db.redFlag.findUniqueOrThrow({ where: { id } });
  if (f.status === "CLOSED") return f;
  if (f.status !== "IMPLEMENTED") throw new ValidationError("The corrective action must be implemented before closing");
  const closedAt = now();
  const sla = await getSetting("redFlagSlaWorkingDays", db);
  const within = withinWorkingDays(f.raisedOn, closedAt, sla, await holidaySet(db));
  const u = await db.redFlag.update({ where: { id }, data: { status: "CLOSED", closedAt, closedWithin1WorkingDay: within, achievedOutcome: achievedOutcome ?? f.achievedOutcome } });
  await audit(actor, "RED_FLAG", "red_flag", id, { action: "closed", within1WorkingDay: within }, db);
  return u;
}

/** "Red flags noticed" / "Action taken" for the weekly sheet. */
export async function redFlagSummary(team: TeamCode[], start: Date, end: Date, db: Tx = prisma) {
  const flags = await db.redFlag.findMany({ where: { teamCode: { in: team }, raisedOn: { gte: start, lt: end } }, include: { agent: true }, orderBy: { raisedOn: "asc" } });
  return {
    noticed: flags.map((f) => `${istDateKey(f.raisedOn)} ${f.agent ? f.agent.name + ": " : ""}${f.description}`).join("\n"),
    actions: flags.filter((f) => f.capaSuggested || f.correctiveActionImplemented).map((f) => `${f.correctiveActionImplemented ?? f.capaSuggested}${f.status === "CLOSED" ? " (closed)" : ""}`).join("\n"),
    count: flags.length,
  };
}
