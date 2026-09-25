import type { FastifyInstance } from "fastify";
import { authRoutes } from "./auth/routes";
import { exportRoutes } from "./exports/routes";
import { fileRoutes } from "./files/routes";
import { integrationRoutes } from "./integrations/routes";
import { pushRoutes } from "./push/routes";
import { notificationRoutes } from "./notifications/routes";
import { taskRoutes } from "./tasks/routes";
import { leadRoutes } from "./candidates/routes";
import { outreachRoutes } from "./outreach/routes";
import { profileRoutes } from "./users/routes";
import { vacancyRoutes } from "./vacancies/routes";
import { evaluationRoutes } from "./eval/routes";
import { kpiRoutes } from "./kpi/routes";
import { redFlagRoutes } from "./redflags/routes";
import { importRoutes } from "./import/routes";
import { adminRoutes } from "./admin/routes";

/** Route plugins mounted by buildApp, one per domain. */
export const modules: Array<(app: FastifyInstance) => Promise<void>> = [
  authRoutes,
  pushRoutes,
  taskRoutes,
  notificationRoutes,
  leadRoutes,
  outreachRoutes,
  profileRoutes,
  vacancyRoutes,
  evaluationRoutes,
  kpiRoutes,
  redFlagRoutes,
  importRoutes,
  adminRoutes,
  fileRoutes,
  exportRoutes,
  integrationRoutes,
];
