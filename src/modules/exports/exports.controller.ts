import { Controller, Module } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { formatDate } from "@contracts/shared/dates";
import { hasRole, ForbiddenError } from "@/lib/rbac";
import { notFound } from "@/lib/http-errors";
import { RawEndpoint, type RawCtx, type UserActor } from "@/platform/endpoint";
import { kpiWorkbook } from "@/kpi/export";
import { dailyWorkbook, parseDailyExport, monthLabel } from "@/kpi/daily";
import { canExportKpis, parsePeriod } from "@/kpi/access";
import { evaluationWorkbook } from "@/modules/eval/service";
import { rejectsWorkbook } from "@/modules/import/pipeline";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const sendXlsx = (reply: FastifyReply, buf: Buffer | ArrayBuffer, filename: string) =>
  reply.header("content-type", XLSX).header("content-disposition", `attachment; filename="${filename}"`).header("cache-control", "no-store").send(Buffer.from(buf as ArrayBuffer));

/** Excel downloads. Plain links from the browser, so they are raw routes rather than typed JSON endpoints. */
@Controller()
export class ExportsController {
  @RawEndpoint("GET", "/v1/kpi/export", {
    tag: "kpi",
    summary: "KPI workbook (.xlsx) for a week or month",
    query: z.object({ period: z.enum(["WEEK", "MONTH"]).optional(), date: z.string().optional() }),
  })
  async kpiExport({ actor, query, reply }: RawCtx<UserActor>) {
    if (!canExportKpis(actor)) throw new ForbiddenError("Only team leaders, the TA coordinator, admin and the data analyst can export KPIs");
    const p = parsePeriod(query as { period?: string; date?: string });
    const buf = await kpiWorkbook(p.periodType, p.anchor);
    const name = `${p.periodType === "WEEK" ? "Weekly" : "Monthly"}-analysis-${formatDate(p.start)}.xlsx`;
    await audit(actor, "EXPORT", "kpi_workbook", `${p.periodType}:${p.start.toISOString()}`, { periodType: p.periodType, start: p.start, end: p.end, file: name });
    return sendXlsx(reply, buf, name);
  }

  @RawEndpoint("GET", "/v1/kpi/daily/export", {
    tag: "kpi",
    summary: "Daily dashboard workbook (.xlsx) for a month: a tab per person plus Consolidated, in the TA team workbook layout",
    query: z.object({ sheet: z.enum(["T1A", "T2"]).optional(), month: z.string().max(7).optional() }),
  })
  async kpiDailyExport({ actor, query, reply }: RawCtx<UserActor>) {
    if (!canExportKpis(actor)) throw new ForbiddenError("Only team leaders, the TA coordinator, admin and the data analyst can export KPIs");
    const { sheet, month } = parseDailyExport(query as { sheet?: string; month?: string });
    const buf = await dailyWorkbook(sheet, month);
    const name = `TA-team-${sheet === "T1A" ? "1" : "2"}-daily-dashboard-${monthLabel(month).replace(" ", "-")}.xlsx`;
    await audit(actor, "EXPORT", "kpi_daily_workbook", `${sheet}:${month}`, { sheet, month, file: name });
    return sendXlsx(reply, buf, name);
  }

  @RawEndpoint("GET", "/v1/evaluations/{id}/export", { tag: "evaluations", summary: "Evaluation scorecard (.xlsx)", params: z.object({ id: z.string() }) })
  async evaluationExport({ actor, params, reply }: RawCtx<UserActor>) {
    if (!hasRole(actor, "recruiter", "team3_leader", "admin")) throw new ForbiddenError("Only recruiters, the Team 3 leader and admin can export evaluations");
    const { id } = params;
    const e = await prisma.evaluation.findUnique({ where: { id }, select: { id: true, title: true } });
    if (!e) throw notFound("Evaluation not found");
    const buf = await evaluationWorkbook(id);
    await audit(actor, "EXPORT", "evaluation", id, { format: "xlsx" });
    return sendXlsx(reply, buf, `${e.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "scorecard"}.xlsx`);
  }

  @RawEndpoint("GET", "/v1/imports/{batchId}/rejects", { tag: "imports", summary: "Rejected import rows (.xlsx)", params: z.object({ batchId: z.string() }) })
  async importRejects({ actor, params, reply }: RawCtx<UserActor>) {
    if (!hasRole(actor, "data_analyst", "admin", "team1_leader")) throw new ForbiddenError("Only the data analyst, Team 1 leader and admin can download rejects");
    const { batchId } = params;
    const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw notFound("Import batch not found");
    const buf = await rejectsWorkbook(batchId);
    await audit(actor, "EXPORT", "import_batch", batchId, { kind: "rejects" });
    const base = batch.fileName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").slice(0, 60) || "import";
    return sendXlsx(reply, buf, `${base}-rejects.xlsx`);
  }
}

@Module({ controllers: [ExportsController] })
export class ExportsModule {}
