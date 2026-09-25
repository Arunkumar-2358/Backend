import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Channel, DeletionRequestStatus, JobStatus, MainCategory, PeriodType, Role, TeamCode } from "@prisma/client";
import { route } from "@/http/route";
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

export async function adminRoutes(app: FastifyInstance) {
  // ── Users & roles ─────────────────────────────────────────────────────────
  route(app, "GET /v1/admin/users", {
    summary: "Users with their team/role grants, and the teams list",
    handler: async ({ actor }) => {
      requireAdmin(actor, VIEW);
      return q.usersPage();
    },
  });

  route(app, "POST /v1/admin/users", {
    summary: "Create a user with a temporary password and an optional first grant",
    body: grantBody.extend({ name: text(200), email: text(320), password: z.string().max(200).optional().transform((v) => (v?.trim() ? v.trim() : undefined)), phone: text(40) }),
    handler: async ({ actor, body }) => {
      requireAdmin(actor);
      return { message: await svc.createUser(actor, body) };
    },
  });

  route(app, "POST /v1/admin/users/{id}/grants", {
    summary: "Add (or update the category of) a team/role grant",
    params: idParam,
    body: grantBody,
    handler: async ({ actor, params, body }) => {
      requireAdmin(actor);
      return { message: await svc.addGrant(actor, params.id, body) };
    },
  });

  route(app, "DELETE /v1/admin/grants/{id}", {
    summary: "Remove a team/role grant (the last active admin cannot remove their own admin grant)",
    params: idParam,
    handler: async ({ actor, params }) => {
      requireAdmin(actor);
      return { message: await svc.removeGrant(actor, params.id) };
    },
  });

  route(app, "POST /v1/admin/users/{id}/active", {
    summary: "Activate or deactivate a user",
    params: idParam,
    body: z.object({ active: z.boolean() }),
    handler: async ({ actor, params, body }) => {
      requireAdmin(actor);
      return { message: await svc.setUserActive(actor, params.id, body.active) };
    },
  });

  route(app, "POST /v1/admin/users/{id}/password", {
    summary: "Set a temporary password",
    params: idParam,
    body: z.object({ password: z.string().max(200).optional().transform((v) => (v?.trim() ? v.trim() : undefined)) }),
    handler: async ({ actor, params, body }) => {
      requireAdmin(actor);
      return { message: await svc.resetPassword(actor, params.id, body.password) };
    },
  });

  // ── Assignment rules ──────────────────────────────────────────────────────
  route(app, "GET /v1/admin/rules", {
    summary: "Assignment rules with the active users and teams for the editors",
    handler: async ({ actor }) => {
      requireAdmin(actor, VIEW);
      return q.rulesPage();
    },
  });

  route(app, "POST /v1/admin/rules", {
    summary: "Add a rule, or update it when id is given",
    body: z.object({
      id: text(100),
      teamCode: optEnum(TeamCode),
      category: optEnum(MainCategory),
      userId: text(100),
      priority: z.number().finite().optional(),
      active: z.boolean(),
    }),
    handler: async ({ actor, body }) => {
      requireAdmin(actor);
      return { message: await svc.saveRule(actor, body) };
    },
  });

  route(app, "DELETE /v1/admin/rules/{id}", {
    summary: "Delete an assignment rule",
    params: idParam,
    handler: async ({ actor, params }) => {
      requireAdmin(actor);
      return { message: await svc.deleteRule(actor, params.id) };
    },
  });

  // ── Message templates ─────────────────────────────────────────────────────
  route(app, "GET /v1/admin/templates", {
    summary: "All message templates, by key",
    handler: async ({ actor }) => {
      requireAdmin(actor, VIEW);
      return q.templatesPage();
    },
  });

  route(app, "POST /v1/admin/templates", {
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
    handler: async ({ actor, body }) => {
      requireAdmin(actor);
      return { message: await svc.saveTemplate(actor, body) };
    },
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  route(app, "GET /v1/admin/settings", {
    summary: "Current business settings and their defaults",
    handler: async ({ actor }) => {
      requireAdmin(actor, VIEW);
      return q.settingsPage();
    },
  });

  route(app, "PUT /v1/admin/settings", {
    summary: "Save the settings form (validated and diffed; changes are audited)",
    body: z.object({ fields: z.record(z.string().max(200), z.array(z.string().max(2000)).max(200)) }),
    handler: async ({ actor, body }) => {
      requireAdmin(actor);
      return { message: await svc.saveSettings(actor, body.fields) };
    },
  });

  // ── Holidays ──────────────────────────────────────────────────────────────
  route(app, "GET /v1/admin/holidays", {
    summary: "Holiday calendar, by date",
    handler: async ({ actor }) => {
      requireAdmin(actor, VIEW);
      return q.holidaysPage();
    },
  });

  route(app, "POST /v1/admin/holidays", {
    summary: "Add a holiday (or rename the one on that date)",
    body: z.object({ date: text(20), name: text(200) }),
    handler: async ({ actor, body }) => {
      requireAdmin(actor);
      return { message: await svc.addHoliday(actor, body) };
    },
  });

  route(app, "DELETE /v1/admin/holidays/{id}", {
    summary: "Remove a holiday",
    params: idParam,
    handler: async ({ actor, params }) => {
      requireAdmin(actor);
      return { message: await svc.removeHoliday(actor, params.id) };
    },
  });

  // ── KPI targets ───────────────────────────────────────────────────────────
  route(app, "GET /v1/admin/targets", {
    summary: "KPI targets and the targetable metrics, optionally for one sheet",
    query: z.object({ sheet: z.string().max(40).optional() }),
    handler: async ({ actor, query }) => {
      requireAdmin(actor, VIEW);
      return q.targetsPage(query.sheet || undefined);
    },
  });

  route(app, "POST /v1/admin/targets", {
    summary: "Add or replace a target (one per metric, team and period)",
    body: z.object({
      id: text(100),
      metricKey: text(100),
      teamCode: optEnum(TeamCode),
      periodType: optEnum(PeriodType),
      target: z.number().finite().optional(),
      comparator: text(10),
    }),
    handler: async ({ actor, body }) => {
      requireAdmin(actor);
      return { message: await svc.saveTarget(actor, body) };
    },
  });

  route(app, "DELETE /v1/admin/targets/{id}", {
    summary: "Delete a KPI target",
    params: idParam,
    handler: async ({ actor, params }) => {
      requireAdmin(actor);
      return { message: await svc.deleteTarget(actor, params.id) };
    },
  });

  // ── Attendance ────────────────────────────────────────────────────────────
  route(app, "GET /v1/admin/attendance", {
    summary: "Attendance grid for one IST week (Mon–Sun), optionally one team",
    query: z.object({ week: z.string().max(40).optional(), team: z.string().max(10).optional() }),
    handler: async ({ actor, query }) => {
      requireAdmin(actor, VIEW);
      return q.attendancePage(query);
    },
  });

  route(app, "PUT /v1/admin/attendance", {
    summary: "Save a week of attendance for the listed users",
    body: z.object({ users: keys, days: keys, present: keys }),
    handler: async ({ actor, body }) => {
      requireAdmin(actor);
      return { message: await svc.saveAttendance(actor, body) };
    },
  });

  // ── Data-deletion requests ────────────────────────────────────────────────
  route(app, "GET /v1/admin/deletions", {
    summary: "Data-deletion requests (DPDP), paged",
    query: z.object({ status: optEnum(DeletionRequestStatus), page: pageQuery.optional() }),
    handler: async ({ actor, query }) => {
      requireAdmin(actor, VIEW);
      return q.deletionsPage(query);
    },
  });

  route(app, "POST /v1/admin/deletions/{id}/process", {
    summary: "Anonymise the candidate of a pending deletion request",
    params: idParam,
    handler: async ({ actor, params }) => {
      requireAdmin(actor);
      return { message: await svc.processDeletion(actor, params.id) };
    },
  });

  route(app, "POST /v1/admin/deletions/{id}/reject", {
    summary: "Reject a pending deletion request",
    params: idParam,
    body: z.object({ reason: text(1000) }),
    handler: async ({ actor, params, body }) => {
      requireAdmin(actor);
      return { message: await svc.rejectDeletion(actor, params.id, body.reason) };
    },
  });

  // ── Audit log ─────────────────────────────────────────────────────────────
  route(app, "GET /v1/admin/audit", {
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
    handler: async ({ actor, query }) => {
      requireAdmin(actor, VIEW);
      return q.auditPage(query);
    },
  });

  // ── Scheduled jobs ────────────────────────────────────────────────────────
  route(app, "GET /v1/admin/jobs", {
    summary: "Scheduled jobs with status counts, paged",
    query: z.object({ status: optEnum(JobStatus), type: z.string().max(100).optional(), page: pageQuery.optional() }),
    handler: async ({ actor, query }) => {
      requireAdmin(actor, VIEW);
      return q.jobsPage(query);
    },
  });

  route(app, "POST /v1/admin/jobs/run", {
    summary: "Ensure recurring jobs exist, then run every due job",
    handler: async ({ actor }) => {
      requireAdmin(actor);
      return { message: await svc.runJobsNow(actor) };
    },
  });

  route(app, "POST /v1/admin/kpi/freeze", {
    summary: "Freeze the last completed week and month KPIs (if not already frozen)",
    handler: async ({ actor }) => {
      requireAdmin(actor);
      return { message: await svc.freezeKpisNow(actor) };
    },
  });
}
