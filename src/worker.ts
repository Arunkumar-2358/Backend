/**
 * Background worker: runs scheduled jobs (follow-ups, 60-day availability
 * check-ins, interview reminders, retention checks, pending-vacancy marking,
 * red-flag due alerts, KPI freezing, auth-session purging).
 *
 * Modes:
 *  - REDIS_URL set   → BullMQ: dispatcher (outbox → BullMQ) + processor, see modules/jobs/bullmq.ts.
 *  - REDIS_URL unset → polling: runDueJobs() every WORKER_INTERVAL_MS (dev / test / single box).
 * Either way the `scheduled_jobs` table is the source of truth, and the
 * /v1/cron/run-jobs endpoint can run alongside safely (claims are atomic).
 *
 * Optional: WORKER_HEALTH_PORT exposes GET /healthz and GET /metrics
 * (Bearer METRICS_TOKEN) for this process.
 */
import "./instrument";
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import * as Sentry from "@sentry/node";
import { env } from "@/config/env";
import { prisma } from "@/lib/db";
import { redisEnabled } from "@/platform/redis";
import { metrics, queueDepth } from "@/platform/metrics";
import { ensureRecurringJobs, outboxStats, runDueJobs } from "@/modules/jobs/runner";
import type { BullmqRuntime } from "@/modules/jobs/bullmq";

type Level = "info" | "warn" | "error";
function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, svc: "worker", msg, ...fields });
  (level === "error" ? console.error : console.log)(line);
}

let stopping = false;
let lastTickAt = 0;
let runtime: BullmqRuntime | undefined;
let pollLoop: Promise<void> | undefined;
let wake: (() => void) | undefined;

async function pollTick() {
  try {
    const results = await runDueJobs();
    for (const r of results) log(r.result.startsWith("error:") ? "warn" : "info", "job ran", { jobId: r.id, type: r.type, result: r.result });
    const outbox = await outboxStats();
    for (const [state, n] of Object.entries(outbox)) queueDepth.set({ state: `outbox_${state.toLowerCase()}` }, n);
    lastTickAt = Date.now();
  } catch (e) {
    Sentry.captureException(e);
    log("error", "poll tick failed", { err: String(e) });
  }
}

async function runPolling() {
  while (!stopping) {
    await pollTick();
    if (stopping) break;
    await new Promise<void>((r) => {
      const t = setTimeout(r, env.WORKER_INTERVAL_MS);
      wake = () => { clearTimeout(t); r(); };
    });
  }
}

function startHealthServer(): Server | undefined {
  const port = Number(process.env.WORKER_HEALTH_PORT);
  if (!port) return undefined;
  const tokenOk = (given: string) => {
    if (!env.METRICS_TOKEN) return false;
    const a = Buffer.from(given), b = Buffer.from(env.METRICS_TOKEN);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      const last = runtime ? runtime.lastTickAt() : lastTickAt;
      const healthy = !stopping && Date.now() - last < 3 * env.WORKER_INTERVAL_MS + 60_000;
      res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: healthy, mode: runtime ? "bullmq" : "polling", lastTickAt: last ? new Date(last).toISOString() : null }));
    }
    if (req.url === "/metrics" && env.METRICS_TOKEN && tokenOk((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""))) {
      res.writeHead(200, { "content-type": metrics.contentType });
      return res.end(await metrics.metrics());
    }
    res.writeHead(404).end();
  });
  server.listen(port, () => log("info", "health server listening", { port }));
  return server;
}

async function main() {
  await ensureRecurringJobs();
  if (redisEnabled()) {
    const { startBullmqRuntime, scheduledQueueName } = await import("@/modules/jobs/bullmq");
    runtime = startBullmqRuntime({ concurrency: env.WORKER_CONCURRENCY, intervalMs: env.WORKER_INTERVAL_MS, log });
    log("info", "worker started", { mode: "bullmq", queue: scheduledQueueName(), concurrency: env.WORKER_CONCURRENCY, dispatchIntervalMs: env.WORKER_INTERVAL_MS });
  } else {
    log("warn", "worker started", { mode: "polling", reason: "REDIS_URL not set", intervalMs: env.WORKER_INTERVAL_MS });
    pollLoop = runPolling();
  }
}

const health = startHealthServer();

async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log("info", "stopping", { signal: sig });
  const force = setTimeout(() => { log("error", "shutdown timed out, exiting"); process.exit(1); }, 90_000);
  force.unref();
  try {
    wake?.();
    await pollLoop; // lets the in-flight polling tick finish
    await runtime?.close(); // stops dispatcher, waits for active BullMQ jobs, closes Redis
    health?.close();
    await prisma.$disconnect();
    await Sentry.flush(2_000);
    log("info", "stopped");
    process.exit(0);
  } catch (e) {
    log("error", "shutdown failed", { err: String(e) });
    process.exit(1);
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown(sig));

main().catch(async (e) => {
  Sentry.captureException(e);
  log("error", "worker failed to start", { err: String(e) });
  await Sentry.flush(2_000);
  process.exit(1);
});
