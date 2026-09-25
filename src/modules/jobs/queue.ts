import { prisma, type Tx } from "@/lib/db";

export type JobType =
  | "availability_check"
  | "interview_reminder"
  | "retention_check"
  | "offer_follow_up"
  | "mark_pending_vacancies"
  | "red_flag_due_alerts"
  | "freeze_kpis";

export async function scheduleJob(type: JobType, runAt: Date, payload: Record<string, unknown>, dedupeKey?: string, db: Tx = prisma) {
  if (dedupeKey) {
    return db.scheduledJob.upsert({
      where: { dedupeKey },
      create: { type, runAt, payload: payload as object, dedupeKey },
      update: { runAt, payload: payload as object, status: "PENDING", attempts: 0, lastError: null, doneAt: null },
    });
  }
  return db.scheduledJob.create({ data: { type, runAt, payload: payload as object } });
}

export async function cancelJobs(where: { type?: JobType; candidateId?: string; dedupePrefix?: string }, db: Tx = prisma) {
  return db.scheduledJob.updateMany({
    where: {
      status: "PENDING",
      ...(where.type ? { type: where.type } : {}),
      ...(where.candidateId ? { payload: { path: ["candidateId"], equals: where.candidateId } } : {}),
      ...(where.dedupePrefix ? { dedupeKey: { startsWith: where.dedupePrefix } } : {}),
    },
    data: { status: "CANCELLED" },
  });
}
