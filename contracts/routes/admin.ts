// Endpoints for the admin domain. See contracts/README.md.
// Every endpoint requires the admin role (403 otherwise).
import type {
  AssignmentRule,
  AuditLog,
  Candidate,
  Channel,
  DataDeletionRequest,
  DeletionRequestStatus,
  Holiday,
  JobStatus,
  KpiTarget,
  MainCategory,
  MessageTemplate,
  PeriodType,
  Role,
  ScheduledJob,
  Team,
  TeamCode,
  User,
  UserTeamRole,
} from "../models";
import type { MessageResult } from "../http";
import type { Sheet, Unit } from "../shared/kpi";

// ── Users & roles ───────────────────────────────────────────────────────────
export type AdminUserRow = Omit<User, "passwordHash"> & { roles: (UserTeamRole & { team: Team })[] };
export interface AdminUsersPage {
  users: AdminUserRow[];
  teams: Team[];
}
export interface AdminGrantInput {
  team?: TeamCode;
  role?: Role;
  category?: MainCategory;
}
export type AdminCreateUserInput = AdminGrantInput & { name?: string; email?: string; password?: string; phone?: string };

// ── Assignment rules ────────────────────────────────────────────────────────
export interface AdminRulesPage {
  rules: (AssignmentRule & { user: Pick<User, "name" | "active"> })[];
  users: Pick<User, "id" | "name">[];
  teams: Team[];
}
export interface AdminRuleInput {
  id?: string;
  teamCode?: TeamCode;
  category?: MainCategory;
  userId?: string;
  priority?: number;
  active: boolean;
}

// ── Templates ───────────────────────────────────────────────────────────────
export interface AdminTemplateInput {
  id?: string;
  key?: string;
  name?: string;
  channel?: Channel;
  subject?: string;
  body?: string;
  active: boolean;
}

// ── Settings ────────────────────────────────────────────────────────────────
export interface AdminSettingsPage {
  /** Current values (stored or default), keyed like `defaults`. */
  values: Record<string, unknown>;
  /** DEFAULT_SETTINGS; key order is the form order. */
  defaults: Record<string, unknown>;
}

// ── Holidays ────────────────────────────────────────────────────────────────
export interface AdminHolidayInput {
  /** YYYY-MM-DD (IST calendar day) */
  date?: string;
  name?: string;
}

// ── KPI targets ─────────────────────────────────────────────────────────────
export interface AdminKpiMetric {
  key: string;
  label: string;
  description?: string;
  sheet: Sheet;
  unit: Unit;
}
export interface AdminTargetsPage {
  /** Targets filtered to the requested sheet (all when none). */
  targets: (KpiTarget & { metric: AdminKpiMetric | null })[];
  /** Targetable metrics for the metric picker (filtered to the requested sheet). */
  metrics: AdminKpiMetric[];
}
export interface AdminTargetInput {
  id?: string;
  metricKey?: string;
  teamCode?: TeamCode;
  periodType?: PeriodType;
  target?: number;
  comparator?: string;
}

// ── Attendance ──────────────────────────────────────────────────────────────
export interface AdminAttendancePage {
  monday: Date;
  /** The 7 IST day keys (YYYY-MM-DD), Monday first. */
  days: string[];
  team: TeamCode | null;
  teams: Team[];
  users: { id: string; name: string; teamCodes: TeamCode[] }[];
  /** "userId|YYYY-MM-DD" keys with a saved present row. */
  present: string[];
  /** "userId|YYYY-MM-DD" keys with any saved row. */
  recorded: string[];
}
export interface AdminAttendanceInput {
  users: string[];
  days: string[];
  /** "userId|YYYY-MM-DD" keys ticked present. */
  present: string[];
}

// ── Data deletion ───────────────────────────────────────────────────────────
export interface AdminDeletionsPage {
  total: number;
  page: number;
  pageSize: number;
  rows: (DataDeletionRequest & {
    candidate: Pick<Candidate, "id" | "name" | "candidateCode" | "anonymizedAt">;
    processedByName: string | null;
  })[];
}

// ── Audit log ───────────────────────────────────────────────────────────────
export interface AdminAuditQuery {
  action?: string;
  entityType?: string;
  entityId?: string;
  actor?: string;
  from?: string;
  to?: string;
  page?: number;
}
export interface AdminAuditPage {
  total: number;
  page: number;
  pageSize: number;
  rows: AuditLog[];
  entityTypes: string[];
  users: Pick<User, "id" | "name">[];
}

// ── Scheduled jobs ──────────────────────────────────────────────────────────
export interface AdminJobsPage {
  counts: Record<JobStatus, number>;
  /** Pending jobs due by now. */
  due: number;
  total: number;
  page: number;
  pageSize: number;
  jobs: ScheduledJob[];
  types: string[];
  lastFreezeAt: Date | null;
}

export interface AdminRoutes {
  "GET /v1/admin/users": { response: AdminUsersPage };
  "POST /v1/admin/users": { body: AdminCreateUserInput; response: MessageResult };
  "POST /v1/admin/users/{id}/grants": { params: { id: string }; body: AdminGrantInput; response: MessageResult };
  "DELETE /v1/admin/grants/{id}": { params: { id: string }; response: MessageResult };
  "POST /v1/admin/users/{id}/active": { params: { id: string }; body: { active: boolean }; response: MessageResult };
  "POST /v1/admin/users/{id}/password": { params: { id: string }; body: { password?: string }; response: MessageResult };

  "GET /v1/admin/rules": { response: AdminRulesPage };
  "POST /v1/admin/rules": { body: AdminRuleInput; response: MessageResult };
  "DELETE /v1/admin/rules/{id}": { params: { id: string }; response: MessageResult };

  "GET /v1/admin/templates": { response: MessageTemplate[] };
  "POST /v1/admin/templates": { body: AdminTemplateInput; response: MessageResult };

  "GET /v1/admin/settings": { response: AdminSettingsPage };
  /** Raw form fields: every submitted value per field name (objects use "key.sub"). */
  "PUT /v1/admin/settings": { body: { fields: Record<string, string[]> }; response: MessageResult };

  "GET /v1/admin/holidays": { response: Holiday[] };
  "POST /v1/admin/holidays": { body: AdminHolidayInput; response: MessageResult };
  "DELETE /v1/admin/holidays/{id}": { params: { id: string }; response: MessageResult };

  "GET /v1/admin/targets": { query?: { sheet?: string }; response: AdminTargetsPage };
  "POST /v1/admin/targets": { body: AdminTargetInput; response: MessageResult };
  "DELETE /v1/admin/targets/{id}": { params: { id: string }; response: MessageResult };

  "GET /v1/admin/attendance": { query?: { week?: string; team?: string }; response: AdminAttendancePage };
  "PUT /v1/admin/attendance": { body: AdminAttendanceInput; response: MessageResult };

  "GET /v1/admin/deletions": { query?: { status?: DeletionRequestStatus; page?: number }; response: AdminDeletionsPage };
  "POST /v1/admin/deletions/{id}/process": { params: { id: string }; response: MessageResult };
  "POST /v1/admin/deletions/{id}/reject": { params: { id: string }; body: { reason?: string }; response: MessageResult };

  "GET /v1/admin/audit": { query?: AdminAuditQuery; response: AdminAuditPage };

  "GET /v1/admin/jobs": { query?: { status?: JobStatus; type?: string; page?: number }; response: AdminJobsPage };
  "POST /v1/admin/jobs/run": { response: MessageResult };
  "POST /v1/admin/kpi/freeze": { response: MessageResult };
}
