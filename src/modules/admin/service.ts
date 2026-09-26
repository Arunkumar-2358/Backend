/** Admin commands (formerly the web's admin server actions). Callers must be admins; see requireAdmin. */
import bcrypt from "bcryptjs";
import { Channel, MainCategory, Role, TeamCode } from "@prisma/client";
import type { AdminAttendanceInput, AdminCreateUserInput, AdminGrantInput, AdminHolidayInput, AdminRuleInput, AdminTargetInput, AdminTemplateInput } from "@contracts";
import { MANDATORY_CHOICES, SETTING_META } from "@contracts/shared/admin-settings";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { audit, diffFields } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";
import type { Actor } from "@/lib/rbac";
import { DEFAULT_SETTINGS, getAllSettings, setSetting, type SettingKey, type Settings } from "@/lib/settings";
import { KPI_BY_KEY, SHEETS } from "@/kpi/definitions";
import { freezeDuePeriods } from "@/kpi/snapshots";
import { ensureRecurringJobs, runDueJobs } from "@/modules/jobs/runner";
import { processDeletionRequest } from "@/modules/candidates/service";
import { revokeUserSessions } from "@/modules/auth/sessions";
import { TARGETABLE_UNITS, utcDay } from "./helpers";

type UserActor = Extract<Actor, { kind: "user" }>;

const TEAM_CODES = Object.values(TeamCode) as TeamCode[];
const ROLES = Object.values(Role) as Role[];
const CATEGORIES = Object.values(MainCategory) as MainCategory[];
const CHANNELS: Channel[] = ["WHATSAPP", "SMS", "EMAIL"];

// ── Users & roles ───────────────────────────────────────────────────────────

function grantOf(input: AdminGrantInput) {
  const { team, role } = input;
  const category = input.category ?? null;
  if (!team || !TEAM_CODES.includes(team)) throw new ValidationError("Choose a team");
  if (!role || !ROLES.includes(role)) throw new ValidationError("Choose a role");
  if (category && !CATEGORIES.includes(category)) throw new ValidationError("Unknown category");
  return { team, role, category };
}

export async function createUser(actor: Actor, input: AdminCreateUserInput) {
  const name = input.name;
  const email = input.email?.toLowerCase();
  const password = input.password;
  if (!name) throw new ValidationError("Name is required");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError("Enter a valid email");
  if (!password || password.length < 8) throw new ValidationError("Temporary password must be at least 8 characters");
  if (await prisma.user.findUnique({ where: { email } })) throw new ValidationError(`A user with ${email} already exists`);
  const grant = input.team ? grantOf(input) : null;
  const user = await prisma.user.create({ data: { name, email, passwordHash: await bcrypt.hash(password, 10), phone: input.phone ?? null } });
  if (grant) {
    const team = await prisma.team.findUniqueOrThrow({ where: { code: grant.team } });
    await prisma.userTeamRole.create({ data: { userId: user.id, teamId: team.id, role: grant.role, category: grant.category } });
  }
  await audit(actor, "CREATE", "user", user.id, { name, email, grant });
  return `User ${name} created`;
}

export async function addGrant(actor: Actor, userId: string, input: AdminGrantInput) {
  const g = grantOf(input);
  const team = await prisma.team.findUniqueOrThrow({ where: { code: g.team } });
  await prisma.userTeamRole.upsert({
    where: { userId_teamId_role: { userId, teamId: team.id, role: g.role } },
    create: { userId, teamId: team.id, role: g.role, category: g.category },
    update: { category: g.category },
  });
  await audit(actor, "SETTING_CHANGE", "user", userId, { action: "grant_added", ...g });
  return "Grant saved — takes effect on the user's next request";
}

export async function removeGrant(actor: UserActor, id: string) {
  const g = await prisma.userTeamRole.findUniqueOrThrow({ where: { id }, include: { team: true } });
  if (g.userId === actor.id && g.role === "admin") {
    const otherAdmins = await prisma.userTeamRole.count({ where: { role: "admin", userId: { not: actor.id }, user: { active: true } } });
    if (!otherAdmins) throw new ValidationError("You are the only active admin — add another admin first");
  }
  await prisma.userTeamRole.delete({ where: { id } });
  // Roles are reloaded on every request; revoking also ends refresh tokens minted under the old grants.
  // The acting admin trimming their own grants keeps their session.
  if (g.userId !== actor.id) await revokeUserSessions(g.userId, "role grant removed by admin");
  await audit(actor, "SETTING_CHANGE", "user", g.userId, { action: "grant_removed", team: g.team.code, role: g.role, category: g.category });
  return "Grant removed";
}

export async function setUserActive(actor: UserActor, userId: string, active: boolean) {
  if (userId === actor.id && !active) throw new ValidationError("You cannot deactivate yourself");
  await prisma.user.update({ where: { id: userId }, data: { active } });
  if (!active) await revokeUserSessions(userId, "deactivated by admin");
  await audit(actor, "SETTING_CHANGE", "user", userId, { active: { from: !active, to: active } });
  return active ? "User activated" : "User deactivated — they are signed out on their next request";
}

export async function resetPassword(actor: Actor, userId: string, password: string | undefined) {
  if (!password || password.length < 8) throw new ValidationError("Temporary password must be at least 8 characters");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(password, 10) } });
  await revokeUserSessions(userId, "password reset by admin");
  await audit(actor, "SETTING_CHANGE", "user", userId, { action: "password_reset" });
  return "Temporary password set";
}

// ── Assignment rules ────────────────────────────────────────────────────────

function ruleOf(input: AdminRuleInput) {
  const { teamCode, userId } = input;
  const category = input.category ?? null;
  if (!teamCode || !TEAM_CODES.includes(teamCode)) throw new ValidationError("Choose a team");
  if (category && !CATEGORIES.includes(category)) throw new ValidationError("Unknown category");
  if (!userId) throw new ValidationError("Choose the user who receives the leads");
  return { teamCode, category, userId, priority: Math.round(input.priority ?? 0), active: input.active };
}

export async function saveRule(actor: Actor, input: AdminRuleInput) {
  const id = input.id;
  const data = ruleOf(input);
  if (id) {
    const before = await prisma.assignmentRule.findUniqueOrThrow({ where: { id } });
    await prisma.assignmentRule.update({ where: { id }, data });
    await audit(actor, "SETTING_CHANGE", "assignment_rule", id, { from: before, to: data });
  } else {
    const r = await prisma.assignmentRule.create({ data });
    await audit(actor, "CREATE", "assignment_rule", r.id, data);
  }
  return id ? "Rule updated" : "Rule added";
}

export async function deleteRule(actor: Actor, id: string) {
  const before = await prisma.assignmentRule.findUniqueOrThrow({ where: { id } });
  await prisma.assignmentRule.delete({ where: { id } });
  await audit(actor, "SETTING_CHANGE", "assignment_rule", id, { action: "deleted", rule: before });
  return "Rule deleted";
}

// ── Message templates ───────────────────────────────────────────────────────

export async function saveTemplate(actor: Actor, input: AdminTemplateInput) {
  const { id, key, name, channel, body } = input;
  if (!key || !/^[a-z0-9_]+$/.test(key)) throw new ValidationError("Key must be lower-case letters, digits and underscores");
  if (!name) throw new ValidationError("Name is required");
  if (!channel || !CHANNELS.includes(channel)) throw new ValidationError("Choose a channel");
  if (!body) throw new ValidationError("Body is required");
  const data = { key, name, channel, subject: channel === "EMAIL" ? (input.subject ?? null) : null, body, active: input.active };
  const clash = await prisma.messageTemplate.findUnique({ where: { key } });
  if (clash && clash.id !== id) throw new ValidationError(`Another template already uses the key "${key}"`);
  if (id) {
    const before = await prisma.messageTemplate.findUniqueOrThrow({ where: { id } });
    await prisma.messageTemplate.update({ where: { id }, data });
    const diff = diffFields(before as unknown as Record<string, unknown>, data);
    if (Object.keys(diff).length) await audit(actor, "SETTING_CHANGE", "message_template", id, diff);
  } else {
    const t = await prisma.messageTemplate.create({ data });
    await audit(actor, "CREATE", "message_template", t.id, data);
  }
  return id ? "Template saved" : "Template created";
}

// ── Settings ────────────────────────────────────────────────────────────────

function parseNumber(v: string | undefined, label: string) {
  if (v === undefined) throw new ValidationError(`${label} is required`);
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${label} must be a non-negative number`);
  return n;
}

/** Save the settings form. `fields` holds every submitted value per form field name (FormData semantics). */
export async function saveSettings(actor: Actor, fields: Record<string, string[]>) {
  const str = (k: string) => {
    const v = fields[k]?.[0];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };
  const current = await getAllSettings();
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
    const def = DEFAULT_SETTINGS[key] as unknown;
    const label = SETTING_META[key]?.label ?? key;
    if (key === "mandatorySopFields") {
      const picked = (fields[key] ?? []).map(String).filter((k) => MANDATORY_CHOICES.some((c) => c.key === k));
      if (!picked.length) throw new ValidationError("Pick at least one mandatory SOP field");
      next[key] = picked;
    } else if (Array.isArray(def)) {
      const parts = (str(key) ?? "").split(/[,\s]+/).filter(Boolean);
      next[key] = parts.map((p) => parseNumber(p, label));
      if (!parts.length) throw new ValidationError(`${label}: enter at least one value`);
    } else if (typeof def === "number") {
      next[key] = parseNumber(str(key), label);
    } else if (typeof def === "string") {
      const v = str(key);
      if (!v) throw new ValidationError(`${label} is required`);
      next[key] = v;
    } else if (def && typeof def === "object") {
      const obj: Record<string, number> = {};
      const cur = (current[key] ?? def) as Record<string, number>;
      for (const sub of new Set([...Object.keys(def as object), ...Object.keys(cur)])) obj[sub] = parseNumber(str(`${key}.${sub}`), `${label} – ${sub}`);
      next[key] = obj;
    }
  }
  if (typeof next.enrolmentLinkTemplate === "string" && !next.enrolmentLinkTemplate.includes("{{code}}")) throw new ValidationError("The enrolment link template must contain {{code}}");
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(next)) {
    if (JSON.stringify(current[k as SettingKey]) === JSON.stringify(v)) continue;
    diff[k] = { from: current[k as SettingKey], to: v };
    await setSetting(k as SettingKey, v as Settings[SettingKey]);
  }
  if (!Object.keys(diff).length) return "No changes";
  await audit(actor, "SETTING_CHANGE", "app_setting", Object.keys(diff).join(","), diff);
  return `Saved ${Object.keys(diff).length} setting${Object.keys(diff).length === 1 ? "" : "s"}`;
}

// ── Holidays ────────────────────────────────────────────────────────────────

export async function addHoliday(actor: Actor, input: AdminHolidayInput) {
  const date = utcDay(input.date ?? "", "Pick a date");
  const name = input.name;
  if (!name) throw new ValidationError("Name the holiday");
  const h = await prisma.holiday.upsert({ where: { date }, create: { date, name }, update: { name } });
  await audit(actor, "SETTING_CHANGE", "holiday", h.id, { action: "added", date: input.date, name });
  return "Holiday saved";
}

export async function removeHoliday(actor: Actor, id: string) {
  const h = await prisma.holiday.delete({ where: { id } });
  await audit(actor, "SETTING_CHANGE", "holiday", id, { action: "removed", date: h.date.toISOString().slice(0, 10), name: h.name });
  return "Holiday removed";
}

// ── KPI targets ─────────────────────────────────────────────────────────────

export async function saveTarget(actor: Actor, input: AdminTargetInput) {
  const { id, metricKey } = input;
  const def = metricKey ? KPI_BY_KEY[metricKey] : undefined;
  if (!metricKey || !def || !TARGETABLE_UNITS.includes(def.unit)) throw new ValidationError("Choose a metric");
  const teamCode = input.teamCode ?? SHEETS.find((s) => s.sheet === def.sheet)!.team;
  if (!TEAM_CODES.includes(teamCode)) throw new ValidationError("Unknown team");
  const periodType = input.periodType;
  if (periodType !== "WEEK" && periodType !== "MONTH") throw new ValidationError("Choose week or month");
  const target = input.target;
  if (target === undefined) throw new ValidationError("Enter a target value");
  const comparator = input.comparator === "lte" ? "lte" : "gte";
  const data = { metricKey, teamCode, periodType, target, comparator };
  const clash = await prisma.kpiTarget.findUnique({ where: { metricKey_teamCode_periodType: { metricKey, teamCode, periodType } } });
  if (clash && clash.id !== id) {
    await prisma.kpiTarget.update({ where: { id: clash.id }, data });
    if (id) await prisma.kpiTarget.delete({ where: { id } });
  } else if (id) {
    await prisma.kpiTarget.update({ where: { id }, data });
  } else {
    await prisma.kpiTarget.create({ data });
  }
  await audit(actor, "SETTING_CHANGE", "kpi_target", `${metricKey}:${teamCode}:${periodType}`, { before: clash ?? null, after: data });
  return "Target saved";
}

export async function deleteTarget(actor: Actor, id: string) {
  const t = await prisma.kpiTarget.delete({ where: { id } });
  await audit(actor, "SETTING_CHANGE", "kpi_target", `${t.metricKey}:${t.teamCode}:${t.periodType}`, { action: "deleted", target: t });
  return "Target deleted";
}

// ── Attendance ──────────────────────────────────────────────────────────────

export async function saveAttendance(actor: Actor, input: AdminAttendanceInput) {
  const users = input.users.filter(Boolean);
  const days = input.days.filter(Boolean);
  if (!users.length || days.length !== 7) throw new ValidationError("Nothing to save");
  const present = new Set(input.present.filter(Boolean));
  let marked = 0;
  await prisma.$transaction(
    users.flatMap((userId) =>
      days.map((day) => {
        const isPresent = present.has(`${userId}|${day}`);
        if (isPresent) marked++;
        const date = utcDay(day);
        return prisma.attendance.upsert({
          where: { userId_date: { userId, date } },
          create: { userId, date, present: isPresent },
          update: { present: isPresent },
        });
      }),
    ),
  );
  await audit(actor, "SETTING_CHANGE", "attendance", days[0], { week: `${days[0]}..${days[6]}`, users: users.length, presentDays: marked });
  return `Attendance saved (${marked} present day${marked === 1 ? "" : "s"})`;
}

// ── Data-deletion requests ──────────────────────────────────────────────────

async function pendingDeletion(id: string) {
  const req = await prisma.dataDeletionRequest.findUniqueOrThrow({ where: { id } });
  if (req.status !== "REQUESTED") throw new ValidationError("This request has already been handled");
  return req;
}

export async function processDeletion(actor: Actor, id: string) {
  await pendingDeletion(id);
  await prisma.$transaction((tx) => processDeletionRequest(actor, id, tx));
  return "Candidate anonymised";
}

export async function rejectDeletion(actor: UserActor, id: string, reason: string | undefined) {
  const req = await pendingDeletion(id);
  await prisma.dataDeletionRequest.update({ where: { id }, data: { status: "REJECTED", processedAt: now(), processedById: actor.id, ...(reason ? { reason: [req.reason, `Rejected: ${reason}`].filter(Boolean).join(" · ") } : {}) } });
  await audit(actor, "DATA_DELETION", "data_deletion_request", id, { action: "rejected", candidateId: req.candidateId, reason });
  return "Request rejected";
}

// ── Scheduled jobs ──────────────────────────────────────────────────────────

export async function runJobsNow(actor: Actor) {
  await ensureRecurringJobs();
  const results = await runDueJobs();
  const failed = results.filter((r) => r.result.startsWith("error")).length;
  await audit(actor, "JOB_RUN", "scheduled_job", "manual-run", { ran: results.length, failed });
  return results.length ? `Ran ${results.length} job${results.length === 1 ? "" : "s"}${failed ? ` · ${failed} failed (see last error)` : ""}` : "No jobs were due";
}

export async function freezeKpisNow(actor: Actor) {
  const summary = await freezeDuePeriods();
  await audit(actor, "JOB_RUN", "kpi_snapshot", "manual-freeze", { summary });
  return `Freeze: ${summary}`;
}
