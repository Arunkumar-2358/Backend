import { HealthModule } from "./health/health.controller";
import { MetricsModule } from "@/platform/metrics";
import { AuthModule } from "./auth/auth.controller";
import { TasksModule } from "./tasks/tasks.controller";
import { PushModule } from "./push/push.controller";
import { NotificationsModule } from "./notifications/notifications.controller";
import { LeadsModule } from "./candidates/candidates.controller";
import { OutreachModule } from "./outreach/outreach.controller";
import { EngagementModule } from "./engagement/engagement.controller";
import { ColdCallsModule } from "./coldcalls/coldcalls.controller";
import { ProfileModule } from "./users/users.controller";
import { VacanciesModule } from "./vacancies/vacancies.controller";
import { EvaluationsModule } from "./eval/eval.controller";
import { KpiModule } from "./kpi/kpi.controller";
import { RedFlagsModule } from "./redflags/redflags.controller";
import { ImportsModule } from "./import/import.controller";
import { AdminModule } from "./admin/admin.controller";
import { FilesModule } from "./files/files.controller";
import { ExportsModule } from "./exports/exports.controller";
import { IntegrationsModule } from "./integrations/integrations.controller";

/** Domain modules mounted by AppModule, one per bounded context. */
export const domainModules = [
  HealthModule,
  MetricsModule,
  AuthModule,
  PushModule,
  TasksModule,
  NotificationsModule,
  LeadsModule,
  OutreachModule,
  EngagementModule,
  ColdCallsModule,
  ProfileModule,
  VacanciesModule,
  EvaluationsModule,
  KpiModule,
  RedFlagsModule,
  ImportsModule,
  AdminModule,
  FilesModule,
  ExportsModule,
  IntegrationsModule,
];
