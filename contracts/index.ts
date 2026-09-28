export type * from "./models";
export type * from "./http";
export type { Actor, RoleGrant } from "./shared/rbac";
export type * from "./routes/auth";
export type * from "./routes/push";
export type * from "./routes/tasks";
export type * from "./routes/leads";
export type * from "./routes/outreach";
export type * from "./routes/engagement";
export type * from "./routes/profile";
export type * from "./routes/vacancies";
export type * from "./routes/evaluations";
export type * from "./routes/kpi";
export type * from "./routes/redflags";
export type * from "./routes/imports";
export type * from "./routes/admin";

import type { AuthRoutes } from "./routes/auth";
import type { PushRoutes } from "./routes/push";
import type { TaskRoutes } from "./routes/tasks";
import type { LeadRoutes } from "./routes/leads";
import type { OutreachRoutes } from "./routes/outreach";
import type { EngagementRoutes } from "./routes/engagement";
import type { ProfileRoutes } from "./routes/profile";
import type { VacancyRoutes } from "./routes/vacancies";
import type { EvaluationRoutes } from "./routes/evaluations";
import type { KpiRoutes } from "./routes/kpi";
import type { RedFlagRoutes } from "./routes/redflags";
import type { ImportRoutes } from "./routes/imports";
import type { AdminRoutes } from "./routes/admin";

/** Every endpoint the API serves, keyed "METHOD /path/{param}". */
export type ApiRoutes = AuthRoutes &
  PushRoutes &
  TaskRoutes &
  LeadRoutes &
  OutreachRoutes &
  EngagementRoutes &
  ProfileRoutes &
  VacancyRoutes &
  EvaluationRoutes &
  KpiRoutes &
  RedFlagRoutes &
  ImportRoutes &
  AdminRoutes;
