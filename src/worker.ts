/**
 * Background worker: runs scheduled jobs (follow-ups, 60-day availability
 * check-ins, interview reminders, retention checks, pending-vacancy marking,
 * red-flag due alerts, KPI freezing). `npm run worker`
 */
import { ensureRecurringJobs, runDueJobs } from "@/modules/jobs/runner";
import { prisma } from "@/lib/db";

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 30_000);
let stopping = false;

async function tick() {
  try {
    const results = await runDueJobs();
    for (const r of results) console.log(`[worker] ${new Date().toISOString()} ${r.type} → ${r.result}`);
  } catch (e) {
    console.error("[worker] tick failed", e);
  }
}

async function main() {
  await ensureRecurringJobs();
  console.log(`[worker] started, polling every ${INTERVAL_MS / 1000}s`);
  while (!stopping) {
    await tick();
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  await prisma.$disconnect();
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopping = true; console.log("[worker] stopping…"); });
main();
