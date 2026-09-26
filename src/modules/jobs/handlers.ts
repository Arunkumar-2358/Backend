import type { ScheduledJob } from "@prisma/client";
import type { Tx } from "@/lib/db";
import { now, DAY, HOUR } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { getAllSettings } from "@/lib/settings";
import { SYSTEM } from "@/lib/rbac";
import { formatDateTime, istDateKey, startOfIstDay } from "@contracts/shared/dates";
import { ensureOpenTask, createTask } from "@/modules/tasks/service";
import { sendTemplate } from "@/modules/messaging/service";
import { notify } from "@/modules/notifications/service";
import { purgeDeadSessions } from "@/modules/auth/sessions";
import { scheduleJob } from "./queue";

const sys = SYSTEM("scheduler");

type Handler = (job: ScheduledJob, db: Tx) => Promise<string | void>;

export const HANDLERS: Record<string, Handler> = {
  /** 60-day availability check-in for Qualified leads (recurs while Qualified). */
  async availability_check(job, db) {
    const { candidateId } = job.payload as { candidateId: string };
    const lead = await db.candidate.findUnique({ where: { id: candidateId } });
    if (!lead || lead.stage !== "QUALIFIED") return "skipped: not qualified";
    await ensureOpenTask(sys, { type: "AVAILABILITY_CHECK", title: `Availability check-in${lead.isCold ? " (cold lead)" : ""}`, candidateId, assigneeId: lead.ownerUserId, dueAt: now() }, db);
    const s = await getAllSettings(db);
    await scheduleJob("availability_check", new Date(now().getTime() + s.availabilityCheckIntervalDays * DAY), { candidateId }, `avail:${candidateId}`, db);
    return "task created";
  },

  /** Interview reminders to the candidate (T-24h, T-2h). */
  async interview_reminder(job, db) {
    const { interviewId, hoursBefore } = job.payload as { interviewId: string; hoursBefore: number };
    const iv = await db.interview.findUnique({ where: { id: interviewId }, include: { submission: { include: { vacancy: { include: { clientOrg: true } } } } } });
    if (!iv || iv.status !== "SCHEDULED") return "skipped: interview no longer scheduled";
    await sendTemplate(sys, iv.submission.candidateId, "interview_reminder", "WHATSAPP", {
      interviewAt: formatDateTime(iv.scheduledAt),
      org: iv.submission.vacancy.clientOrg.name,
      role: iv.submission.vacancy.title,
      hoursBefore,
    }, db);
    await db.interview.update({ where: { id: interviewId }, data: { remindersSent: { increment: 1 } } });
    await audit(sys, "REMINDER_SENT", "interview", interviewId, { hoursBefore }, db);
    await notify(iv.submission.vacancy.recruiterId, { kind: "INTERVIEW", title: `Interview in ${hoursBefore}h`, body: `${iv.submission.vacancy.title} · ${iv.submission.vacancy.clientOrg.name} · ${formatDateTime(iv.scheduledAt)}`, link: "/recruitment" }, db);
    return "reminder sent";
  },

  /** Day-7 / day-30 retention checkpoints after joining. */
  async retention_check(job, db) {
    const { joiningId, day } = job.payload as { joiningId: string; day: number };
    const j = await db.joining.findUnique({ where: { id: joiningId }, include: { offer: { include: { submission: { include: { candidate: true, vacancy: true } } } } } });
    if (!j || j.leftAt) return "skipped";
    const lead = j.offer.submission.candidate;
    if (lead.stage !== "JOINED") return "skipped: not joined";
    await ensureOpenTask(sys, {
      type: "RETENTION_CHECK",
      title: `Day-${day} retention check`,
      candidateId: lead.id,
      assigneeId: j.offer.submission.vacancy.recruiterId ?? lead.ownerUserId,
      dueAt: now(),
      refType: `joining_d${day}`,
      refId: joiningId,
    }, db);
    return "task created";
  },

  /** Offer follow-ups until the joining date is confirmed. */
  async offer_follow_up(job, db) {
    const { offerId } = job.payload as { offerId: string };
    const offer = await db.offer.findUnique({ where: { id: offerId }, include: { submission: { include: { candidate: true, vacancy: true } }, joining: true } });
    if (!offer || offer.joining || offer.declinedAt) return "skipped";
    if (offer.submission.candidate.stage !== "SELECTED") return "skipped: not selected";
    if (!offer.joiningDate || !offer.acceptedAt) {
      await ensureOpenTask(sys, { type: "OFFER_FOLLOW_UP", title: "Offer follow-up: confirm joining date", candidateId: offer.submission.candidateId, assigneeId: offer.submission.vacancy.recruiterId, dueAt: now(), refType: "offer", refId: offerId }, db);
    } else {
      await ensureOpenTask(sys, { type: "OFFER_FOLLOW_UP", title: `Confirm candidate joins on ${formatDateTime(offer.joiningDate)}`, candidateId: offer.submission.candidateId, assigneeId: offer.submission.vacancy.recruiterId, dueAt: offer.joiningDate, refType: "offer", refId: offerId }, db);
    }
    const s = await getAllSettings(db);
    await scheduleJob("offer_follow_up", new Date(now().getTime() + s.offerFollowupIntervalHours * HOUR), { offerId }, `offer:${offerId}`, db);
    return "follow-up ensured";
  },

  /** Nightly: open vacancies from a previous day without the full CV target become PENDING. */
  async mark_pending_vacancies(_job, db) {
    const s = await getAllSettings(db);
    const today = startOfIstDay(now());
    const open = await db.vacancy.findMany({ where: { status: "OPEN", postedAt: { lt: today }, sourcingCompletedAt: null }, include: { _count: { select: { submissions: true } } } });
    let n = 0;
    for (const v of open) {
      if (v._count.submissions < s.cvTargetPerVacancy) {
        await db.vacancy.update({ where: { id: v.id }, data: { status: "PENDING", wasPending: true } });
        n++;
      }
    }
    await scheduleJob("mark_pending_vacancies", new Date(today.getTime() + DAY + 23 * HOUR), {}, "mark_pending_vacancies", db);
    return `${n} marked pending`;
  },

  /** Daily: due-date alerts for red-flag CAPA owners. */
  async red_flag_due_alerts(_job, db) {
    const end = new Date(startOfIstDay(now()).getTime() + DAY);
    const due = await db.redFlag.findMany({ where: { status: { not: "CLOSED" }, dueDate: { lt: end }, actionOwnerId: { not: null } } });
    for (const f of due) {
      const key = istDateKey(now());
      const exists = await db.task.findFirst({ where: { refType: "red_flag", refId: f.id, title: { contains: key } } });
      if (!exists)
        await createTask(sys, { type: "GENERAL", title: `Red flag CAPA due (${key}): ${f.description.slice(0, 60)}`, assigneeId: f.actionOwnerId, dueAt: f.dueDate ?? now(), refType: "red_flag", refId: f.id }, db);
    }
    await scheduleJob("red_flag_due_alerts", new Date(end.getTime() + 4 * HOUR), {}, "red_flag_due_alerts", db);
    return `${due.length} alerts`;
  },

  /** Freeze KPI snapshots at period end and raise automatic red flags. */
  async freeze_kpis(job, db) {
    const { freezeDuePeriods } = await import("@/kpi/snapshots");
    const out = await freezeDuePeriods(db);
    const nextRun = new Date(startOfIstDay(now()).getTime() + DAY + 30 * 60_000);
    await scheduleJob("freeze_kpis", nextRun, {}, "freeze_kpis", db);
    return out;
  },
  /** Daily 03:00 IST: delete auth sessions that expired / were revoked more than 30 days ago. */
  async purge_auth_sessions(_job, db) {
    const { count } = await purgeDeadSessions(30, db);
    await scheduleJob("purge_auth_sessions", new Date(startOfIstDay(now()).getTime() + DAY + 3 * HOUR), {}, "purge_auth_sessions", db);
    return `${count} sessions purged`;
  },
};
