/**
 * BullMQ transport for the `scheduled_jobs` outbox. Everything BullMQ-specific
 * lives here; the rest of the jobs module is framework-free.
 *
 * Design (see runner.ts for the row state machine):
 *  - Postgres is the source of truth. Business code writes rows transactionally
 *    (scheduleJob); Redis only carries "run row X now" messages.
 *  - Dispatcher: a self-rescheduling timer in every worker process. Each tick
 *    reaps stale rows, then moves due PENDING rows to QUEUED with
 *    `FOR UPDATE SKIP LOCKED` (markDueQueued) and adds one BullMQ job per row
 *    with `jobId = scheduled_job.id`. No Redis lock or BullMQ repeatable job is
 *    needed: the atomic UPDATE … RETURNING already guarantees each row is handed
 *    out once, so N replicas can dispatch concurrently, and there is no
 *    repeatable-job state in Redis to clean up when the interval changes.
 *  - Processor: calls runJob(id), whose conditional claim makes a duplicate or
 *    stale BullMQ message a no-op.
 *  - Retries are owned by the DB row: runJob charges the attempt and puts the
 *    row back to PENDING with runAt = now + backoff, so the dispatcher re-queues
 *    it later. BullMQ `attempts: 1`; completed/failed BullMQ jobs are removed so
 *    the same jobId can be re-added on the next attempt.
 *  - Losing Redis loses nothing: QUEUED rows older than STALE_QUEUED_MS go back
 *    to PENDING (reaper), and the cron endpoint's runDueJobs keeps working.
 */
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { env } from "@/config/env";
import { redisConnection } from "@/platform/redis";
import { queueDepth } from "@/platform/metrics";
import { markDueQueued, outboxStats, reapStaleJobs, runJob, unmarkQueued } from "./runner";

export type ScheduledJobMessage = { id: string };
type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export const scheduledQueueName = () => `${env.QUEUE_PREFIX}-scheduled`;

const JOB_OPTS = { attempts: 1, removeOnComplete: true, removeOnFail: true } as const;

/** Queue due outbox rows into BullMQ. Returns the number of rows handed over. */
export async function dispatchDueJobs(queue: Queue<ScheduledJobMessage>, opts: { batchSize?: number; maxBatches?: number } = {}): Promise<number> {
  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatches ?? 20;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const rows = await markDueQueued(batchSize);
    if (!rows.length) break;
    try {
      await queue.addBulk(rows.map((r) => ({ name: r.type, data: { id: r.id }, opts: { ...JOB_OPTS, jobId: r.id } })));
    } catch (e) {
      // Redis unavailable: give the rows straight back instead of waiting for the reaper.
      await unmarkQueued(rows.map((r) => r.id)).catch(() => undefined);
      throw e;
    }
    total += rows.length;
    if (rows.length < batchSize) break;
  }
  return total;
}

/** Sample BullMQ and outbox counts into the `nt_queue_jobs` gauge. */
export async function sampleQueueDepth(queue: Queue<ScheduledJobMessage>) {
  const [counts, outbox] = await Promise.all([
    queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "prioritized"),
    outboxStats(),
  ]);
  for (const [state, n] of Object.entries(counts)) queueDepth.set({ state }, n);
  for (const [state, n] of Object.entries(outbox)) queueDepth.set({ state: `outbox_${state.toLowerCase()}` }, n);
  return { queue: counts, outbox };
}

export type BullmqRuntime = {
  queue: Queue<ScheduledJobMessage>;
  worker: Worker<ScheduledJobMessage>;
  /** Run one dispatcher tick now (reap + dispatch + sample). */
  tick(): Promise<void>;
  lastTickAt(): number;
  close(): Promise<void>;
};

/**
 * Start the BullMQ processor and the dispatcher loop. `close()` stops the
 * dispatcher, waits for in-flight jobs to finish and closes the Redis connections.
 */
export function startBullmqRuntime(opts: { concurrency: number; intervalMs: number; log: Log; connection?: () => Redis }): BullmqRuntime {
  const connect = opts.connection ?? (() => redisConnection());
  const queueConn = connect();
  const workerConn = connect();
  const name = scheduledQueueName();
  const queue = new Queue<ScheduledJobMessage>(name, { connection: queueConn });
  const log = opts.log;

  const worker = new Worker<ScheduledJobMessage>(
    name,
    async (job: Job<ScheduledJobMessage>) => {
      const id = job.data?.id ?? job.id!;
      const started = Date.now();
      const r = await runJob(id);
      if (!r) {
        log("info", "job not claimable, skipped", { jobId: id, type: job.name });
        return "skipped: not claimable";
      }
      log(r.outcome === "done" ? "info" : "warn", "job ran", { jobId: r.id, type: r.type, outcome: r.outcome, result: r.result, ms: Date.now() - started });
      return r.result;
    },
    { connection: workerConn, concurrency: opts.concurrency },
  );
  worker.on("failed", (job, err) => log("error", "bullmq processor failed (row stays QUEUED/RUNNING until reaped)", { jobId: job?.id, err: String(err) }));
  worker.on("error", (err) => log("error", "bullmq worker error", { err: String(err) }));

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> | undefined;
  let last = 0;

  const tick = async () => {
    try {
      const reaped = await reapStaleJobs();
      if (reaped.requeued || reaped.recovered || reaped.failed) log("warn", "reaped stale jobs", reaped);
      const dispatched = await dispatchDueJobs(queue);
      if (dispatched) log("info", "dispatched due jobs", { dispatched });
      const depth = await sampleQueueDepth(queue);
      last = Date.now();
      if (depth.outbox.DUE || depth.outbox.FAILED || depth.queue.failed) log("info", "queue depth", { ...depth.queue, outboxDue: depth.outbox.DUE, outboxFailed: depth.outbox.FAILED });
    } catch (e) {
      log("error", "dispatcher tick failed", { err: String(e) });
    }
  };
  const loop = () => {
    if (stopped) return;
    current = tick().finally(() => {
      current = undefined;
      if (!stopped) timer = setTimeout(loop, opts.intervalMs);
    });
  };
  loop();

  return {
    queue,
    worker,
    tick: () => (current ??= tick().finally(() => (current = undefined))),
    lastTickAt: () => last,
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
      await worker.close(); // waits for active jobs
      await queue.close();
      await Promise.allSettled([queueConn.quit(), workerConn.quit()]);
    },
  };
}
