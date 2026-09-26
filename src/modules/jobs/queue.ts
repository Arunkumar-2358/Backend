import { prisma, type Tx } from "@/lib/db";

export type JobType =
  | "availability_check"
  | "interview_reminder"
  | "retention_check"
  | "offer_follow_up"
  | "mark_pending_vacancies"
  | "red_flag_due_alerts"
  | "freeze_kpis"
  | "purge_auth_sessions";

/**
 * Write a job to the `scheduled_jobs` outbox — pass the caller's transaction so
 * the job exists iff the business change commits. Re-scheduling an existing
 * dedupe key resets it to PENDING; if it was already QUEUED in BullMQ, the stale
 * BullMQ job is harmless because the executor only claims rows whose runAt is due.
 */
export async function scheduleJob(type: JobType, runAt: Date, payload: Record<string, unknown>, dedupeKey?: string, db: Tx = prisma) {
  if (dedupeKey) {
    return db.scheduledJob.upsert({
      where: { dedupeKey },
      create: { type, runAt, payload: payload as object, dedupeKey },
      update: { runAt, payload: payload as object, status: "PENDING", attempts: 0, lastError: null, doneAt: null, queuedAt: null },
    });
  }
  return db.scheduledJob.create({ data: { type, runAt, payload: payload as object } });
}

/**
 * Cancel not-yet-run jobs. QUEUED rows (already handed to BullMQ) are cancelled
 * too: the executor's claim only accepts PENDING/QUEUED rows, so a BullMQ job
 * whose row was cancelled becomes a no-op.
 */
export async function cancelJobs(where: { type?: JobType; candidateId?: string; dedupePrefix?: string }, db: Tx = prisma) {
  return db.scheduledJob.updateMany({
    where: {
      status: { in: ["PENDING", "QUEUED"] },
      ...(where.type ? { type: where.type } : {}),
      ...(where.candidateId ? { payload: { path: ["candidateId"], equals: where.candidateId } } : {}),
      ...(where.dedupePrefix ? { dedupeKey: { startsWith: where.dedupePrefix } } : {}),
    },
    data: { status: "CANCELLED" },
  });
}
