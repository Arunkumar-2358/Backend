import { z } from "zod";
import { Channel, DeletionRequestStatus, JobStatus, MainCategory, PeriodType, Role, TeamCode } from "@prisma/client";
import { Controller, Module } from "@nestjs/common";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { idParam, pageQuery } from "@/http/schemas";
import { requireAdmin } from "./helpers";
import * as q from "./queries";
import * as svc from "./service";

const VIEW = "Only an admin can view this";

/** Optional form text: trimmed, blank → undefined (the web's str() semantics). */
const text = (max = 500) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));
const optEnum = <T extends Record<string, string>>(e: T) => z.nativeEnum(e).optional();
const keys = z.array(z.string().max(200)).max(5000);

const grantBody = z.object({ team: optEnum(TeamCode), role: optEnum(Role), category: optEnum(MainCategory) });

@Controller()
export class AdminController {
  // ── Users & roles ─────────────────────────────────────────────────────────
  @Endpoint("GET /v1/admin/users", {
    summary: "Users with their team/role grants, and the teams list",
  })
  async getAdminUsers({ actor }: Ctx<"GET /v1/admin/users">) {
    requireAdmin(actor, VIEW);
    return q.usersPage();
  }

  @Endpoint("POST /v1/admin/users", {
    summary: "Create a user with a temporary password and an optional first grant",
    body: grantBody.extend({ name: text(200), email: text(320), password: z.string().max(200).optional().transform((v) => (v?.trim() ? v.trim() : undefined)), phone: text(40) }),
  })
  async postAdminUsers({ actor, body }: Ctx<"POST /v1/admin/users">) {
    requireAdmin(actor);
    return { message: await svc.createUser(actor, body) };
  }

  @Endpoint("POST /v1/admin/users/{id}/grants", {
    summary: "Add (or update the category of) a team/role grant",
    params: idParam,
    body: grantBody,
  })
  async postAdminUsersGrants({ actor, params, body }: Ctx<"POST /v1/admin/users/{id}/grants">) {
    requireAdmin(actor);
    return { message: await svc.addGrant(actor, params.id, body) };
  }

  @Endpoint("DELETE /v1/admin/grants/{id}", {
    summary: "Remove a team/role grant (the last active admin cannot remove their own admin grant)",
    params: idParam,
  })
  async deleteAdminGrants({ actor, params }: Ctx<"DELETE /v1/admin/grants/{id}">) {
    requireAdmin(actor);
    return { message: await svc.removeGrant(actor, params.id) };
  }

  @Endpoint("POST /v1/admin/users/{id}/active", {
    summary: "Activate or deactivate a user",
    params: idParam,
    body: z.object({ active: z.boolean() }),
  })
  async postAdminUsersActive({ actor, params, body }: Ctx<"POST /v1/admin/users/{id}/active">) {
    requireAdmin(actor);
    return { message: await svc.setUserActive(actor, params.id, body.active) };
  }

  @Endpoint("POST /v1/admin/users/{id}/password", {
    summary: "Set a temporary password",
    params: idParam,
    body: z.object({ password: z.string().max(200).optional().transform((v) => (v?.trim() ? v.trim() : undefined)) }),
  })
  async postAdminUsersPassword({ actor, params, body }: Ctx<"POST /v1/admin/users/{id}/password">) {
    requireAdmin(actor);
    return { message: await svc.resetPassword(actor, params.id, body.password) };
  }

  // ── Assignment rules ──────────────────────────────────────────────────────
  @Endpoint("GET /v1/admin/rules", {
    summary: "Assignment rules with the active users and teams for the editors",
  })
  async getAdminRules({ actor }: Ctx<"GET /v1/admin/rules">) {
    requireAdmin(actor, VIEW);
    return q.rulesPage();
  }

  @Endpoint("POST /v1/admin/rules", {
    summary: "Add a rule, or update it when id is given",
    body: z.object({
      id: text(100),
      teamCode: optEnum(TeamCode),
      category: optEnum(MainCategory),
      userId: text(100),
      priority: z.number().finite().optional(),
      active: z.boolean(),
    }),
  })
  async postAdminRules({ actor, body }: Ctx<"POST /v1/admin/rules">) {
    requireAdmin(actor);
    return { message: await svc.saveRule(actor, body) };
  }

  @Endpoint("DELETE /v1/admin/rules/{id}", {
    summary: "Delete an assignment rule",
    params: idParam,
  })
  async deleteAdminRules({ actor, params }: Ctx<"DELETE /v1/admin/rules/{id}">) {
    requireAdmin(actor);
    return { message: await svc.deleteRule(actor, params.id) };
  }

  // ── Message templates ─────────────────────────────────────────────────────
  @Endpoint("GET /v1/admin/templates", {
    summary: "All message templates, by key",
  })
  async getAdminTemplates({ actor }: Ctx<"GET /v1/admin/templates">) {
    requireAdmin(actor, VIEW);
    return q.templatesPage();
  }

  @Endpoint("POST /v1/admin/templates", {
    summary: "Create a template, or save it when id is given",
    body: z.object({
      id: text(100),
      key: text(100),
      name: text(200),
      channel: optEnum(Channel),
      subject: text(500),
      body: text(10_000),
      active: z.boolean(),
    }),
  })
  async postAdminTemplates({ actor, body }: Ctx<"POST /v1/admin/templates">) {
    requireAdmin(actor);
    return { message: await svc.saveTemplate(actor, body) };
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  @Endpoint("GET /v1/admin/settings", {
    summary: "Current business settings and their defaults",
  })
  async getAdminSettings({ actor }: Ctx<"GET /v1/admin/settings">) {
    requireAdmin(actor, VIEW);
    return q.settingsPage();
  }

  @Endpoint("PUT /v1/admin/settings", {
    summary: "Save the settings form (validated and diffed; changes are audited)",
    body: z.object({ fields: z.record(z.string().max(200), z.array(z.string().max(2000)).max(200)) }),
  })
  async putAdminSettings({ actor, body }: Ctx<"PUT /v1/admin/settings">) {
    requireAdmin(actor);
    return { message: await svc.saveSettings(actor, body.fields) };
  }

  // ── Holidays ──────────────────────────────────────────────────────────────
  @Endpoint("GET /v1/admin/holidays", {
    summary: "Holiday calendar, by date",
  })
  async getAdminHolidays({ actor }: Ctx<"GET /v1/admin/holidays">) {
    requireAdmin(actor, VIEW);
    return q.holidaysPage();
  }

  @Endpoint("POST /v1/admin/holidays", {
    summary: "Add a holiday (or rename the one on that date)",
    body: z.object({ date: text(20), name: text(200) }),
  })
  async postAdminHolidays({ actor, body }: Ctx<"POST /v1/admin/holidays">) {
    requireAdmin(actor);
    return { message: await svc.addHoliday(actor, body) };
  }

  @Endpoint("DELETE /v1/admin/holidays/{id}", {
    summary: "Remove a holiday",
    params: idParam,
  })
  async deleteAdminHolidays({ actor, params }: Ctx<"DELETE /v1/admin/holidays/{id}">) {
    requireAdmin(actor);
    return { message: await svc.removeHoliday(actor, params.id) };
  }

  // ── KPI targets ───────────────────────────────────────────────────────────
  @Endpoint("GET /v1/admin/targets", {
    summary: "KPI targets and the targetable metrics, optionally for one sheet",
    query: z.object({ sheet: z.string().max(40).optional() }),
  })
  async getAdminTargets({ actor, query }: Ctx<"GET /v1/admin/targets">) {
    requireAdmin(actor, VIEW);
    return q.targetsPage(query.sheet || undefined);
  }

  @Endpoint("POST /v1/admin/targets", {
    summary: "Add or replace a target (one per metric, team and period)",
    body: z.object({
      id: text(100),
      metricKey: text(100),
      teamCode: optEnum(TeamCode),
      periodType: optEnum(PeriodType),
      target: z.number().finite().optional(),
      comparator: text(10),
    }),
  })
  async postAdminTargets({ actor, body }: Ctx<"POST /v1/admin/targets">) {
    requireAdmin(actor);
    return { message: await svc.saveTarget(actor, body) };
  }

  @Endpoint("DELETE /v1/admin/targets/{id}", {
    summary: "Delete a KPI target",
    params: idParam,
  })
  async deleteAdminTargets({ actor, params }: Ctx<"DELETE /v1/admin/targets/{id}">) {
    requireAdmin(actor);
    return { message: await svc.deleteTarget(actor, params.id) };
  }

  // ── Attendance ────────────────────────────────────────────────────────────
  @Endpoint("GET /v1/admin/attendance", {
    summary: "Attendance grid for one IST week (Mon–Sun), optionally one team",
    query: z.object({ week: z.string().max(40).optional(), team: z.string().max(10).optional() }),
  })
  async getAdminAttendance({ actor, query }: Ctx<"GET /v1/admin/attendance">) {
    requireAdmin(actor, VIEW);
    return q.attendancePage(query);
  }

  @Endpoint("PUT /v1/admin/attendance", {
    summary: "Save a week of attendance for the listed users",
    body: z.object({ users: keys, days: keys, present: keys }),
  })
  async putAdminAttendance({ actor, body }: Ctx<"PUT /v1/admin/attendance">) {
    requireAdmin(actor);
    return { message: await svc.saveAttendance(actor, body) };
  }

  // ── Data-deletion requests ────────────────────────────────────────────────
  @Endpoint("GET /v1/admin/deletions", {
    summary: "Data-deletion requests (DPDP), paged",
    query: z.object({ status: optEnum(DeletionRequestStatus), page: pageQuery.optional() }),
  })
  async getAdminDeletions({ actor, query }: Ctx<"GET /v1/admin/deletions">) {
    requireAdmin(actor, VIEW);
    return q.deletionsPage(query);
  }

  @Endpoint("POST /v1/admin/deletions/{id}/process", {
    summary: "Anonymise the candidate of a pending deletion request",
    params: idParam,
  })
  async postAdminDeletionsProcess({ actor, params }: Ctx<"POST /v1/admin/deletions/{id}/process">) {
    requireAdmin(actor);
    return { message: await svc.processDeletion(actor, params.id) };
  }

  @Endpoint("POST /v1/admin/deletions/{id}/reject", {
    summary: "Reject a pending deletion request",
    params: idParam,
    body: z.object({ reason: text(1000) }),
  })
  async postAdminDeletionsReject({ actor, params, body }: Ctx<"POST /v1/admin/deletions/{id}/reject">) {
    requireAdmin(actor);
    return { message: await svc.rejectDeletion(actor, params.id, body.reason) };
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  @Endpoint("GET /v1/admin/audit", {
    summary: "Audit log, filtered and paged",
    query: z.object({
      action: z.string().max(40).optional(),
      entityType: z.string().max(100).optional(),
      entityId: z.string().max(200).optional(),
      actor: z.string().max(200).optional(),
      from: z.string().max(40).optional(),
      to: z.string().max(40).optional(),
      page: pageQuery.optional(),
    }),
  })
  async getAdminAudit({ actor, query }: Ctx<"GET /v1/admin/audit">) {
    requireAdmin(actor, VIEW);
    return q.auditPage(query);
  }

  // ── Scheduled jobs ────────────────────────────────────────────────────────
  @Endpoint("GET /v1/admin/jobs", {
    summary: "Scheduled jobs with status counts, paged",
    query: z.object({ status: optEnum(JobStatus), type: z.string().max(100).optional(), page: pageQuery.optional() }),
  })
  async getAdminJobs({ actor, query }: Ctx<"GET /v1/admin/jobs">) {
    requireAdmin(actor, VIEW);
    return q.jobsPage(query);
  }

  @Endpoint("POST /v1/admin/jobs/run", {
    summary: "Ensure recurring jobs exist, then run every due job",
  })
  async postAdminJobsRun({ actor }: Ctx<"POST /v1/admin/jobs/run">) {
    requireAdmin(actor);
    return { message: await svc.runJobsNow(actor) };
  }

  @Endpoint("POST /v1/admin/kpi/freeze", {
    summary: "Freeze the last completed week and month KPIs (if not already frozen)",
  })
  async postAdminKpiFreeze({ actor }: Ctx<"POST /v1/admin/kpi/freeze">) {
    requireAdmin(actor);
    return { message: await svc.freezeKpisNow(actor) };
  }
}

@Module({ controllers: [AdminController] })
export class AdminModule {}
