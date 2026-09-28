import { z } from "zod";
import { Controller, Module } from "@nestjs/common";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { dashboardView, kpiSheetPage } from "./queries";
import { getDailyDashboard } from "@/kpi/daily";

@Controller()
export class KpiController {
  @Endpoint("GET /v1/kpi", {
    summary: "KPI sheet for a week or month (all agents for leaders / coordinator / admin / data analyst, own column otherwise)",
    query: z.object({ period: z.string().optional(), date: z.string().optional(), sheet: z.string().optional() }),
  })
  async getKpi({ actor, query }: Ctx<"GET /v1/kpi">) {
    return kpiSheetPage(actor, query);
  }

  @Endpoint("GET /v1/kpi/daily", {
    summary: "Daily dashboard (the TA team 1 / 2 monthly workbooks): one person's month, or the team's for leaders",
    query: z.object({ sheet: z.string().max(8).optional(), month: z.string().max(7).optional(), user: z.string().max(64).optional() }),
  })
  async getKpiDaily({ actor, query }: Ctx<"GET /v1/kpi/daily">) {
    return getDailyDashboard(actor, query);
  }

  @Endpoint("GET /v1/dashboard", {
    summary: "Role dashboard: own tasks and leads, leader pipeline + weekly KPIs, coordinator and data-analyst panels",
  })
  async getDashboard({ actor }: Ctx<"GET /v1/dashboard">) {
    return dashboardView(actor);
  }
}

@Module({ controllers: [KpiController] })
export class KpiModule {}
