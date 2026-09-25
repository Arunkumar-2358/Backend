import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { formatDate } from "@contracts/shared/dates";
import { hasRole, ForbiddenError } from "@/lib/rbac";
import { requireUser } from "@/plugins/auth";
import { notFound } from "@/plugins/errors";
import { kpiWorkbook } from "@/kpi/export";
import { canExportKpis, parsePeriod } from "@/kpi/access";
import { evaluationWorkbook } from "@/modules/eval/service";
import { rejectsWorkbook } from "@/modules/import/pipeline";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const sendXlsx = (reply: FastifyReply, buf: Buffer | ArrayBuffer, filename: string) =>
  reply.header("content-type", XLSX).header("content-disposition", `attachment; filename="${filename}"`).header("cache-control", "no-store").send(Buffer.from(buf as ArrayBuffer));

/** Excel downloads. Plain links from the browser, so they are raw routes rather than typed JSON endpoints. */
export async function exportRoutes(app: FastifyInstance) {
  app.get(
    "/v1/kpi/export",
    { schema: { tags: ["kpi"], summary: "KPI workbook (.xlsx) for a week or month", querystring: z.object({ period: z.enum(["WEEK", "MONTH"]).optional(), date: z.string().optional() }) } },
    async (req, reply) => {
      const actor = await requireUser(req);
      if (!canExportKpis(actor)) throw new ForbiddenError("Only team leaders, the TA coordinator, admin and the data analyst can export KPIs");
      const p = parsePeriod(req.query as { period?: string; date?: string });
      const buf = await kpiWorkbook(p.periodType, p.anchor);
      const name = `${p.periodType === "WEEK" ? "Weekly" : "Monthly"}-analysis-${formatDate(p.start)}.xlsx`;
      await audit(actor, "EXPORT", "kpi_workbook", `${p.periodType}:${p.start.toISOString()}`, { periodType: p.periodType, start: p.start, end: p.end, file: name });
      return sendXlsx(reply, buf, name);
    },
  );

  app.get("/v1/evaluations/:id/export", { schema: { tags: ["evaluations"], summary: "Evaluation scorecard (.xlsx)", params: z.object({ id: z.string() }) } }, async (req, reply) => {
    const actor = await requireUser(req);
    if (!hasRole(actor, "recruiter", "team3_leader", "admin")) throw new ForbiddenError("Only recruiters, the Team 3 leader and admin can export evaluations");
    const { id } = req.params as { id: string };
    const e = await prisma.evaluation.findUnique({ where: { id }, select: { id: true, title: true } });
    if (!e) throw notFound("Evaluation not found");
    const buf = await evaluationWorkbook(id);
    await audit(actor, "EXPORT", "evaluation", id, { format: "xlsx" });
    return sendXlsx(reply, buf, `${e.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "scorecard"}.xlsx`);
  });

  app.get("/v1/imports/:batchId/rejects", { schema: { tags: ["imports"], summary: "Rejected import rows (.xlsx)", params: z.object({ batchId: z.string() }) } }, async (req, reply) => {
    const actor = await requireUser(req);
    if (!hasRole(actor, "data_analyst", "admin", "team1_leader")) throw new ForbiddenError("Only the data analyst, Team 1 leader and admin can download rejects");
    const { batchId } = req.params as { batchId: string };
    const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw notFound("Import batch not found");
    const buf = await rejectsWorkbook(batchId);
    await audit(actor, "EXPORT", "import_batch", batchId, { kind: "rejects" });
    const base = batch.fileName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").slice(0, 60) || "import";
    return sendXlsx(reply, buf, `${base}-rejects.xlsx`);
  });
}
