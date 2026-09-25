import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route } from "@/http/route";
import { dashboardView, kpiSheetPage } from "./queries";

export async function kpiRoutes(app: FastifyInstance) {
  route(app, "GET /v1/kpi", {
    summary: "KPI sheet for a week or month (all agents for leaders / coordinator / admin / data analyst, own column otherwise)",
    query: z.object({ period: z.string().optional(), date: z.string().optional(), sheet: z.string().optional() }),
    handler: async ({ actor, query }) => kpiSheetPage(actor, query),
  });

  route(app, "GET /v1/dashboard", {
    summary: "Role dashboard: own tasks and leads, leader pipeline + weekly KPIs, coordinator and data-analyst panels",
    handler: async ({ actor }) => dashboardView(actor),
  });
}
