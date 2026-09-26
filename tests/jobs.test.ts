import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { advanceClock, now, MINUTE, DAY } from "@/lib/clock";
import { HANDLERS } from "@/modules/jobs/handlers";
import { cancelJobs, scheduleJob, type JobType } from "@/modules/jobs/queue";
import { MAX_ATTEMPTS, RECURRING_JOBS, ensureRecurringJobs, markDueQueued, reapStaleJobs, runDueJobs, runJob } from "@/modules/jobs/runner";
import { resetDb } from "./helpers";

const PROBE = "test_probe" as JobType;
let calls = 0;
let failWith: string | null = null;

HANDLERS[PROBE] = async () => {
  calls++;
  await new Promise((r) => setTimeout(r, 50));
  if (failWith) throw new Error(failWith);
  return "probed";
};

const probe = (runAt = now()) => scheduleJob(PROBE, runAt, {});
const row = (id: string) => prisma.scheduledJob.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await resetDb();
  calls = 0;
  failWith = null;
});
afterAll(() => {
  delete HANDLERS[PROBE];
});

describe("runJob claim", () => {
  it("never double-executes when two runners race for the same row", async () => {
    const job = await probe();
    const [a, b] = await Promise.all([runJob(job.id), runJob(job.id)]);
    expect(calls).toBe(1);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await row(job.id)).status).toBe("DONE");
    // runDueJobs racing runJob is also safe
    const job2 = await probe();
    await Promise.all([runDueJobs(), runJob(job2.id), runDueJobs()]);
    expect(calls).toBe(2);
  });

  it("does not run a job before its runAt, even if a stale BullMQ message arrives", async () => {
    const job = await probe(new Date(now().getTime() + DAY));
    expect(await runJob(job.id)).toBeNull();
    expect(calls).toBe(0);
    expect((await row(job.id)).status).toBe("PENDING");
  });

  it("honours cancellation of a QUEUED row", async () => {
    const job = await scheduleJob(PROBE, now(), {}, "probe:cancel-me");
    expect((await markDueQueued()).map((r) => r.id)).toEqual([job.id]);
    expect((await row(job.id)).status).toBe("QUEUED");
    const { count } = await cancelJobs({ dedupePrefix: "probe:cancel-" });
    expect(count).toBe(1);
    expect(await runJob(job.id)).toBeNull();
    expect(calls).toBe(0);
    expect((await row(job.id)).status).toBe("CANCELLED");
  });

  it("runs a QUEUED row (the BullMQ path) and records the outcome", async () => {
    const job = await probe();
    await markDueQueued();
    const r = await runJob(job.id);
    expect(r).toMatchObject({ id: job.id, type: PROBE, result: "probed", outcome: "done" });
    expect(await prisma.auditLog.count({ where: { action: "JOB_RUN", entityId: job.id } })).toBe(1);
  });
});

describe("retries", () => {
  it("backs off and ends FAILED after MAX_ATTEMPTS", async () => {
    failWith = "boom";
    const job = await probe();
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const [r] = await runDueJobs();
      expect(r).toMatchObject({ id: job.id, result: "error: Error: boom" });
      const j = await row(job.id);
      expect(j.attempts).toBe(i);
      if (i < MAX_ATTEMPTS) {
        expect(j.status).toBe("PENDING");
        expect(j.runAt.getTime()).toBeGreaterThan(now().getTime());
        expect(await runDueJobs()).toEqual([]); // not due yet (backoff)
        advanceClock(2 * 60 * MINUTE);
      } else {
        expect(j.status).toBe("FAILED");
        expect(j.lastError).toMatch(/boom/);
      }
    }
    expect(calls).toBe(MAX_ATTEMPTS);
    advanceClock(DAY);
    expect(await runDueJobs()).toEqual([]);
  });
});

describe("reaper", () => {
  it("returns stale QUEUED rows to PENDING without charging an attempt", async () => {
    const job = await probe();
    await markDueQueued();
    expect((await reapStaleJobs()).requeued).toBe(0); // fresh
    advanceClock(11 * MINUTE);
    expect((await reapStaleJobs()).requeued).toBe(1);
    const j = await row(job.id);
    expect(j).toMatchObject({ status: "PENDING", attempts: 0, queuedAt: null });
    await runDueJobs();
    expect(calls).toBe(1);
  });

  it("recovers RUNNING rows stuck > 15 min with an attempt increment, FAILED at the limit", async () => {
    const a = await probe();
    const b = await probe();
    await prisma.scheduledJob.update({ where: { id: a.id }, data: { status: "RUNNING", queuedAt: now(), attempts: 1 } });
    await prisma.scheduledJob.update({ where: { id: b.id }, data: { status: "RUNNING", queuedAt: now(), attempts: MAX_ATTEMPTS - 1 } });
    advanceClock(14 * MINUTE);
    expect(await reapStaleJobs()).toEqual({ requeued: 0, recovered: 0, failed: 0 });
    advanceClock(2 * MINUTE);
    expect(await reapStaleJobs()).toEqual({ requeued: 0, recovered: 1, failed: 1 });
    expect(await row(a.id)).toMatchObject({ status: "PENDING", attempts: 2 });
    expect(await row(b.id)).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS });
  });
});

describe("recurring jobs", () => {
  it("registers purge_auth_sessions and it purges dead sessions then reschedules itself", async () => {
    expect(RECURRING_JOBS).toContain("purge_auth_sessions");
    expect(HANDLERS.purge_auth_sessions).toBeTypeOf("function");
    await ensureRecurringJobs();
    const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: "purge_auth_sessions" } });
    expect(job.status).toBe("PENDING");
    const ran = await runDueJobs();
    expect(ran.find((r) => r.type === "purge_auth_sessions")?.result).toMatch(/sessions purged/);
    const next = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: "purge_auth_sessions" } });
    expect(next.status).toBe("PENDING");
    expect(next.runAt.getTime()).toBeGreaterThan(now().getTime());
  });

  it("ensureRecurringJobs does not reset a QUEUED/RUNNING recurring job", async () => {
    await ensureRecurringJobs();
    await prisma.scheduledJob.update({ where: { dedupeKey: "freeze_kpis" }, data: { status: "RUNNING", queuedAt: now() } });
    await ensureRecurringJobs();
    expect((await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: "freeze_kpis" } })).status).toBe("RUNNING");
  });
});

describe.skipIf(!process.env.REDIS_URL)("BullMQ dispatcher + processor (needs REDIS_URL)", () => {
  it("queues due rows and the processor completes them exactly once", async () => {
    const { startBullmqRuntime, dispatchDueJobs } = await import("@/modules/jobs/bullmq");
    const due = await Promise.all([probe(), probe(), probe()]);
    const future = await probe(new Date(now().getTime() + DAY));
    const logs: string[] = [];
    const rt = startBullmqRuntime({ concurrency: 2, intervalMs: 60_000, log: (_l, msg) => logs.push(msg) });
    try {
      await rt.tick(); // the start-up tick (or this one) dispatches the due rows
      expect(await dispatchDueJobs(rt.queue)).toBe(0); // nothing left to hand out
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const done = await prisma.scheduledJob.count({ where: { id: { in: due.map((d) => d.id) }, status: "DONE" } });
        if (done === due.length) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      for (const d of due) expect((await row(d.id)).status).toBe("DONE");
      expect(calls).toBe(3);
      expect((await row(future.id)).status).toBe("PENDING");
      expect(logs).toContain("dispatched due jobs");
    } finally {
      await rt.queue.obliterate({ force: true }).catch(() => undefined);
      await rt.close();
    }
  });
});
