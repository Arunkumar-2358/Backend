/**
 * Framework-free job executor over the `scheduled_jobs` outbox.
 *
 * State machine (the DB row is always authoritative):
 *
 *   PENDING --dispatcher--> QUEUED --runJob claim--> RUNNING --ok--> DONE
 *      ^                      |                        |
 *      |                      | reaper (Redis lost)    | error: attempts+1, runAt = now + backoff
 *      +----------------------+------------------------+   (FAILED at MAX_ATTEMPTS)
 *                                                      | reaper (process crashed mid-job)
 *
 * Both execution paths — the BullMQ processor and `runDueJobs` (cron fallback,
 * polling worker, tests) — go through `runJob`, whose claim is a single
 * conditional UPDATE, so no two runners can ever execute the same row.
 * `queuedAt` records when the row last entered QUEUED or RUNNING; the reaper
 * uses it to detect stuck rows.
 */
import type { JobStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { now, MINUTE, HOUR } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { SYSTEM } from "@/lib/rbac";
import { jobsProcessed } from "@/platform/metrics";
import { HANDLERS } from "./handlers";
import { scheduleJob, type JobType } from "./queue";

export const MAX_ATTEMPTS = 5;
/** QUEUED longer than this ⇒ the BullMQ job was lost (Redis flushed / down); hand the row back to the dispatcher. */
export const STALE_QUEUED_MS = 10 * MINUTE;
/** RUNNING longer than this ⇒ the process died mid-job (handler transactions time out after 60s). */
export const STALE_RUNNING_MS = 15 * MINUTE;

export const RECURRING_JOBS = ["mark_pending_vacancies", "red_flag_due_alerts", "freeze_kpis", "purge_auth_sessions", "engagement_sweep"] as const satisfies readonly JobType[];

export type JobResult = { id: string; type: string; result: string };
export type JobOutcome = "done" | "retry" | "failed" | "no_handler";

/** Retry delay after the n-th failed attempt: 30s, 1m, 2m, 4m … capped at 1h. */
export function retryDelayMs(attempts: number) {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), HOUR);
}

/**
 * Claim and execute one job. Returns null when the row could not be claimed
 * (already running/done/cancelled, re-scheduled into the future, or missing) —
 * callers treat that as "nothing to do".
 */
export async function runJob(jobId: string): Promise<(JobResult & { outcome: JobOutcome }) | null> {
  const t = now();
  const claimed = await prisma.scheduledJob.updateMany({
    where: { id: jobId, status: { in: ["PENDING", "QUEUED"] }, runAt: { lte: t } },
    data: { status: "RUNNING", queuedAt: t },
  });
  if (claimed.count === 0) return null;
  const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: jobId } });

  const handler = HANDLERS[job.type];
  if (!handler) {
    await prisma.scheduledJob.updateMany({ where: { id: job.id, status: "RUNNING" }, data: { status: "FAILED", queuedAt: null, lastError: `No handler for ${job.type}` } });
    jobsProcessed.inc({ type: job.type, outcome: "no_handler" });
    return { id: job.id, type: job.type, result: `error: No handler for ${job.type}`, outcome: "no_handler" };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Mark done first: a recurring handler may re-schedule the same dedupe key.
      // Conditional on RUNNING so a concurrent re-schedule/cancel of this row wins.
      const marked = await tx.scheduledJob.updateMany({ where: { id: job.id, status: "RUNNING" }, data: { status: "DONE", doneAt: now(), attempts: { increment: 1 } } });
      if (marked.count === 0) return "skipped: superseded";
      const r = (await handler(job, tx)) ?? "ok";
      await audit(SYSTEM("scheduler"), "JOB_RUN", "scheduled_job", job.id, { type: job.type, result: r }, tx);
      return r;
    }, { timeout: 60_000 });
    jobsProcessed.inc({ type: job.type, outcome: "done" });
    return { id: job.id, type: job.type, result: String(result), outcome: "done" };
  } catch (e) {
    const attempts = job.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    await prisma.scheduledJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: {
        attempts,
        lastError: String(e).slice(0, 4000),
        status: failed ? "FAILED" : "PENDING",
        queuedAt: null,
        ...(failed ? {} : { runAt: new Date(now().getTime() + retryDelayMs(attempts)) }),
      },
    });
    jobsProcessed.inc({ type: job.type, outcome: failed ? "failed" : "retry" });
    return { id: job.id, type: job.type, result: `error: ${String(e)}`, outcome: failed ? "failed" : "retry" };
  }
}

/**
 * Run every job whose run_at <= now (the clock is injectable, so tests can
 * fast-forward). Each job is claimed and run via `runJob`, so this is safe to
 * call concurrently with the BullMQ worker (the cron endpoint does exactly that).
 */
export async function runDueJobs(limit = 200): Promise<JobResult[]> {
  await reapStaleJobs();
  const due = await prisma.scheduledJob.findMany({ where: { status: "PENDING", runAt: { lte: now() } }, orderBy: { runAt: "asc" }, take: limit, select: { id: true } });
  const results: JobResult[] = [];
  for (const { id } of due) {
    const r = await runJob(id);
    if (r && r.outcome !== "no_handler") results.push({ id: r.id, type: r.type, result: r.result });
  }
  return results;
}

/**
 * Return stuck rows to PENDING:
 *  - QUEUED for > STALE_QUEUED_MS: the BullMQ job was lost; no attempt is charged.
 *  - RUNNING for > STALE_RUNNING_MS: the process crashed mid-job; charged as an
 *    attempt (FAILED once MAX_ATTEMPTS is reached, so a job that kills its
 *    worker can't crash-loop forever).
 */
export async function reapStaleJobs(): Promise<{ requeued: number; recovered: number; failed: number }> {
  const t = now().getTime();
  const lastError = "worker died while running the job";
  const requeued = await prisma.scheduledJob.updateMany({
    where: { status: "QUEUED", OR: [{ queuedAt: { lt: new Date(t - STALE_QUEUED_MS) } }, { queuedAt: null }] },
    data: { status: "PENDING", queuedAt: null },
  });
  const stuck = { status: "RUNNING" as const, OR: [{ queuedAt: { lt: new Date(t - STALE_RUNNING_MS) } }, { queuedAt: null }] };
  const failed = await prisma.scheduledJob.updateMany({
    where: { ...stuck, attempts: { gte: MAX_ATTEMPTS - 1 } },
    data: { status: "FAILED", attempts: { increment: 1 }, queuedAt: null, lastError },
  });
  const recovered = await prisma.scheduledJob.updateMany({
    where: stuck,
    data: { status: "PENDING", attempts: { increment: 1 }, queuedAt: null, lastError },
  });
  return { requeued: requeued.count, recovered: recovered.count, failed: failed.count };
}

/**
 * Dispatcher side of the outbox: atomically move up to `limit` due PENDING rows
 * to QUEUED and return them. `FOR UPDATE SKIP LOCKED` lets several dispatchers
 * (worker replicas) run at once without blocking each other or queueing a row
 * twice, and skips rows a business transaction is currently re-scheduling.
 */
export async function markDueQueued(limit = 500): Promise<{ id: string; type: string }[]> {
  // scheduled_jobs timestamps are `timestamp(3)` holding UTC; convert explicitly
  // so the comparison doesn't depend on the session TimeZone.
  const t = now().toISOString();
  return prisma.$queryRaw<{ id: string; type: string }[]>`
    UPDATE "scheduled_jobs" SET "status" = 'QUEUED', "queuedAt" = (${t}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" IN (
      SELECT "id" FROM "scheduled_jobs"
      WHERE "status" = 'PENDING' AND "runAt" <= (${t}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "runAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "type"`;
}

/** Undo `markDueQueued` for rows whose BullMQ enqueue failed (only if still QUEUED). */
export async function unmarkQueued(ids: string[]) {
  if (!ids.length) return 0;
  const r = await prisma.scheduledJob.updateMany({ where: { id: { in: ids }, status: "QUEUED" }, data: { status: "PENDING", queuedAt: null } });
  return r.count;
}

/** Outbox counts by status, plus due-but-not-yet-dispatched PENDING rows (for metrics / health). */
export async function outboxStats(): Promise<Record<string, number>> {
  const [byStatus, due] = await Promise.all([
    prisma.scheduledJob.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.scheduledJob.count({ where: { status: "PENDING", runAt: { lte: now() } } }),
  ]);
  const out: Record<string, number> = { PENDING: 0, QUEUED: 0, RUNNING: 0, DONE: 0, FAILED: 0, CANCELLED: 0, DUE: due };
  for (const g of byStatus) out[g.status] = g._count._all;
  return out;
}

const LIVE: JobStatus[] =["PENDING", "QUEUED", "RUNNING"];

/** Make sure the recurring system jobs exist (called by the worker at start-up and by the cron endpoint). */
export async function ensureRecurringJobs() {
  for (const type of RECURRING_JOBS) {
    const existing = await prisma.scheduledJob.findUnique({ where: { dedupeKey: type } });
    // QUEUED/RUNNING are live too — resetting them to PENDING could run the job twice.
    if (!existing || !LIVE.includes(existing.status)) await scheduleJob(type, now(), {}, type);
  }
}
