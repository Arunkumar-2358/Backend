import { Controller, Module } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { env } from "@/config/env";
import { RawEndpoint, type RawCtx } from "./endpoint";

export const metrics = new Registry();
collectDefaultMetrics({ register: metrics, prefix: "nt_" });

const httpDuration = new Histogram({
  name: "nt_http_request_duration_seconds",
  help: "HTTP request duration by route and status",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metrics],
});

export const jobsProcessed = new Counter({
  name: "nt_jobs_processed_total",
  help: "Scheduled jobs processed by type and outcome",
  labelNames: ["type", "outcome"] as const,
  registers: [metrics],
});

export const queueDepth = new Gauge({
  name: "nt_queue_jobs",
  help: "BullMQ jobs by state (sampled by the worker)",
  labelNames: ["state"] as const,
  registers: [metrics],
});

/** Record every request against its route pattern (never the raw URL, which carries ids). */
export function observeHttp(app: FastifyInstance) {
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    if (route === "/metrics") return;
    httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });
}

const tokenOk = (given: string) => {
  if (!env.METRICS_TOKEN) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(env.METRICS_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

@Controller()
export class MetricsController {
  /** Prometheus scrape endpoint; requires `Authorization: Bearer $METRICS_TOKEN`, 404 when unset. */
  @RawEndpoint("GET", "/metrics", { auth: "public", hidden: true })
  async scrape({ req, reply }: RawCtx) {
    if (!env.METRICS_TOKEN) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
    if (!tokenOk(req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "")) return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid metrics token" } });
    return reply.header("content-type", metrics.contentType).send(await metrics.metrics());
  }
}

@Module({ controllers: [MetricsController] })
export class MetricsModule {}
