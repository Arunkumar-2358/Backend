import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { SYSTEM } from "@/lib/rbac";
import { HANDLERS } from "./handlers";
import { scheduleJob } from "./queue";

/**
 * Run every job whose run_at <= now (the clock is injectable, so tests can
 * fast-forward). Each job runs in its own transaction; failures are retried
 * up to 5 times.
 */
export async function runDueJobs(limit = 200): Promise<{ id: string; type: string; result: string }[]> {
  const due = await prisma.scheduledJob.findMany({ where: { status: "PENDING", runAt: { lte: now() } }, orderBy: { runAt: "asc" }, take: limit });
  const results: { id: string; type: string; result: string }[] = [];
  for (const job of due) {
    const handler = HANDLERS[job.type];
    if (!handler) {
      await prisma.scheduledJob.update({ where: { id: job.id }, data: { status: "FAILED", lastError: `No handler for ${job.type}` } });
      continue;
    }
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Mark done first: a recurring handler may re-schedule the same dedupe key.
        await tx.scheduledJob.update({ where: { id: job.id }, data: { status: "DONE", doneAt: now(), attempts: { increment: 1 } } });
        const r = (await handler(job, tx)) ?? "ok";
        await audit(SYSTEM("scheduler"), "JOB_RUN", "scheduled_job", job.id, { type: job.type, result: r }, tx);
        return r;
      }, { timeout: 60_000 });
      results.push({ id: job.id, type: job.type, result: String(result) });
    } catch (e) {
      const attempts = job.attempts + 1;
      await prisma.scheduledJob.update({ where: { id: job.id }, data: { attempts, lastError: String(e), status: attempts >= 5 ? "FAILED" : "PENDING" } });
      results.push({ id: job.id, type: job.type, result: `error: ${String(e)}` });
    }
  }
  return results;
}

/** Make sure the recurring system jobs exist (called by the worker at start-up). */
export async function ensureRecurringJobs() {
  for (const type of ["mark_pending_vacancies", "red_flag_due_alerts", "freeze_kpis"] as const) {
    const existing = await prisma.scheduledJob.findUnique({ where: { dedupeKey: type } });
    if (!existing || existing.status !== "PENDING") await scheduleJob(type, now(), {}, type);
  }
}
