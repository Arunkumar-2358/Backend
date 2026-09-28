/**
 * Engagement of enrolled + qualified leads: super active / active / warm / cold,
 * from the last NT platform visit or a confirmed job need (contracts/shared/engagement.ts).
 * Cold leads get a re-engagement WhatsApp; a reply saying they need a job makes
 * them super active immediately.
 */
import type { Candidate, JobIntent } from "@prisma/client";
import { prisma, withTx, type Tx } from "@/lib/db";
import { now, DAY } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { getAllSettings } from "@/lib/settings";
import { ValidationError } from "@/lib/errors";
import { type Actor, ForbiddenError, SYSTEM, isStageLeader, isStageTeamMember } from "@/lib/rbac";
import { validateMobile } from "@contracts/shared/phone";
import { ENGAGEMENT_STAGES, engagementWindow, readJobIntent, type EngagementTierDays } from "@contracts/shared/engagement";
import { findByMobile } from "@/modules/candidates/service";
import { sendTemplate } from "@/modules/messaging/service";
import { closeTasks, ensureOpenTask } from "@/modules/tasks/service";
import { notify } from "@/modules/notifications/service";
import { scheduleJob } from "@/modules/jobs/queue";

export const REENGAGE_TEMPLATE = "reengage_cold_whatsapp";
/** A reply only counts as an answer to the re-engagement message within this many days of it. */
export const REPLY_WINDOW_DAYS = 30;

const later = (a: Date | null | undefined, b: Date) => (a && a > b ? a : b);

export function tierDays(settings: { engagementTierDays: Record<string, number> }): EngagementTierDays {
  const d = settings.engagementTierDays;
  return { superActive: d.superActive, active: d.active, warm: d.warm };
}

/** Moves lastEngagedAt forward (never back). */
export async function touchEngagement(candidateId: string, at: Date, db: Tx = prisma, extra: Partial<Pick<Candidate, "lastPlatformVisitAt" | "jobIntentAt">> = {}) {
  const c = await db.candidate.findUniqueOrThrow({ where: { id: candidateId }, select: { lastEngagedAt: true } });
  await db.candidate.update({ where: { id: candidateId }, data: { lastEngagedAt: later(c.lastEngagedAt, at), ...extra } });
}

// ───────────── NT platform visits ─────────────

export type PlatformVisit = { mobile: string; visitedAt?: string };

/** Records visits reported by the NT platform / app. Unknown or invalid numbers are counted, not created. */
export async function recordPlatformVisits(visits: PlatformVisit[], db: Tx = prisma) {
  let matched = 0;
  let unknown = 0;
  const t = now();
  for (const v of visits) {
    const m = validateMobile(v.mobile);
    const lead = m.ok ? await findByMobile(m.mobile, db) : null;
    if (!lead || lead.anonymizedAt) {
      unknown++;
      continue;
    }
    // A future timestamp (clock skew) counts as now.
    const parsed = v.visitedAt ? new Date(v.visitedAt) : t;
    const at = parsed > t ? t : parsed;
    await db.candidate.update({
      where: { id: lead.id },
      data: { lastPlatformVisitAt: later(lead.lastPlatformVisitAt, at), lastEngagedAt: later(lead.lastEngagedAt, at) },
    });
    matched++;
  }
  return { matched, unknown };
}

// ───────────── Job intent ─────────────

function assertCanWork(actor: Actor, lead: Candidate) {
  if (actor.kind === "system") return;
  const ok = isStageTeamMember(actor, lead.stage) && (lead.ownerUserId === actor.id || isStageLeader(actor, lead.stage));
  if (!ok) throw new ForbiddenError("Only the lead's Team 2 owner or the Team 2 leader can do that");
}

/** The candidate says they need a job (WhatsApp reply, or confirmed on a call) → super active now. */
export async function markJobIntent(actor: Actor, candidateId: string, notes: string | undefined, db: Tx = prisma) {
  return withTx(db, async (tx) => {
    const lead = await tx.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    if (!ENGAGEMENT_STAGES.includes(lead.stage)) throw new ValidationError("Engagement applies to Qualified or Active leads");
    assertCanWork(actor, lead);
    await applyJobIntent(actor, candidateId, notes, tx);
  });
}

/** Records the job need without a permission check — callers (a cold call on an allocated task, the WhatsApp webhook) check their own. */
export async function applyJobIntent(actor: Actor, candidateId: string, notes: string | undefined, tx: Tx) {
  const at = now();
  await tx.candidate.update({ where: { id: candidateId }, data: { jobIntentAt: at, lastEngagedAt: at } });
  await closeTasks({ candidateId, type: "REENGAGE_REPLY" }, "Candidate needs a job — super active", tx);
  await audit(actor, "FIELD_EDIT", "candidate", candidateId, { jobIntentAt: at, engagement: "SUPER_ACTIVE", notes }, tx);
}

// ───────────── Re-engagement WhatsApp ─────────────

/** Sends the re-engagement WhatsApp to one lead and records when. */
export async function sendReengagement(actor: Actor, candidateId: string, db: Tx = prisma) {
  return withTx(db, async (tx) => {
    const lead = await tx.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    if (!ENGAGEMENT_STAGES.includes(lead.stage)) throw new ValidationError("Re-engagement applies to Qualified or Active leads");
    if (lead.anonymizedAt) throw new ValidationError("This lead's data has been deleted");
    assertCanWork(actor, lead);
    const msg = await sendTemplate(actor, candidateId, REENGAGE_TEMPLATE, "WHATSAPP", {}, tx);
    await tx.candidate.update({ where: { id: candidateId }, data: { reengageSentAt: now() } });
    return msg;
  });
}

/**
 * Daily sweep: every Qualified / Active lead that has gone cold and has not been
 * messaged since it was last engaged gets one re-engagement job (capped per day).
 */
export async function queueColdReengagements(db: Tx = prisma) {
  const s = await getAllSettings(db);
  const tpl = await db.messageTemplate.findFirst({ where: { key: REENGAGE_TEMPLATE, active: true }, select: { id: true } });
  if (!tpl) return "skipped: re-engagement template inactive";
  const t = now();
  const cold = engagementWindow("COLD", t, tierDays(s));
  // Excludes a lead whose job is still in flight (PENDING/QUEUED/RUNNING) or already gave up (FAILED)
  // for the *current* cold spell — scheduleJob's upsert would otherwise reset its status and attempts
  // to 0 every sweep, letting a permanently failing send (bad number, provider rejection) retry forever
  // on our quota — and does this *before* the daily limit, so a run of stuck leads can't crowd
  // genuinely-fresh ones out of it. `runAt` is bumped every time this dedupeKey is (re)scheduled, so a
  // job whose runAt predates the lead's latest engagement is from an earlier, since-ended spell and does
  // not block a fresh attempt now.
  const leads = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM candidates c
    WHERE stage::text = ANY(${ENGAGEMENT_STAGES}) AND "anonymizedAt" IS NULL
      AND ("lastEngagedAt" IS NULL OR "lastEngagedAt" < ${cold.to})
      AND ("reengageSentAt" IS NULL OR "reengageSentAt" < COALESCE("lastEngagedAt", 'epoch'::timestamp))
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_jobs sj
        WHERE sj."dedupeKey" = 'reengage:' || c.id AND sj.status <> 'DONE' AND sj."runAt" >= COALESCE(c."lastEngagedAt", 'epoch'::timestamp)
      )
    ORDER BY "lastEngagedAt" DESC NULLS LAST
    LIMIT ${Math.max(0, s.reengageDailyLimit)}`;
  let queued = 0;
  for (const { id } of leads) {
    await scheduleJob("reengage_whatsapp", t, { candidateId: id }, `reengage:${id}`, db);
    queued++;
  }
  return `${queued} re-engagement message(s) queued`;
}

/** Per-lead job: re-checks the lead is still cold and un-messaged, then sends. */
export async function runReengagementJob(candidateId: string, db: Tx) {
  const lead = await db.candidate.findUnique({ where: { id: candidateId } });
  if (!lead || lead.anonymizedAt || !ENGAGEMENT_STAGES.includes(lead.stage)) return "skipped: not qualified / active";
  const s = await getAllSettings(db);
  const cold = engagementWindow("COLD", now(), tierDays(s));
  if (lead.lastEngagedAt && lead.lastEngagedAt >= cold.to!) return "skipped: no longer cold";
  if (lead.reengageSentAt && lead.reengageSentAt >= (lead.lastEngagedAt ?? new Date(0))) return "skipped: already messaged";
  await sendTemplate(SYSTEM("scheduler"), candidateId, REENGAGE_TEMPLATE, "WHATSAPP", {}, db);
  await db.candidate.update({ where: { id: candidateId }, data: { reengageSentAt: now() } });
  return "re-engagement sent";
}

// ───────────── Inbound WhatsApp replies ─────────────

export type InboundWhatsApp = { providerRef: string; from: string; text: string; receivedAt?: Date };

/** True while the lead's latest re-engagement message has had no yes / no answer (within the reply window). */
async function awaitingReply(lead: Candidate, at: Date, db: Tx) {
  if (!lead.reengageSentAt) return false;
  if (at.getTime() - lead.reengageSentAt.getTime() > REPLY_WINDOW_DAYS * DAY) return false;
  const answered = await db.inboundMessage.count({ where: { candidateId: lead.id, receivedAt: { gte: lead.reengageSentAt }, intent: { in: ["LOOKING", "NOT_LOOKING"] } } });
  return answered === 0;
}

/**
 * Handles messages from the WhatsApp webhook. Each is stored once (provider id).
 * Only a reply to a pending re-engagement message is read for job intent:
 * "needs a job" → super active; "not looking" → owner told; anything else → a review task.
 */
export async function handleInboundWhatsApp(messages: InboundWhatsApp[], db: Tx = prisma) {
  const sys = SYSTEM("whatsapp");
  const out = { stored: 0, duplicates: 0, looking: 0, notLooking: 0, review: 0, unmatched: 0 };
  for (const m of messages) {
    await withTx(db, async (tx) => {
      if (await tx.inboundMessage.findUnique({ where: { providerRef: m.providerRef }, select: { id: true } })) {
        out.duplicates++;
        return;
      }
      const phone = validateMobile(m.from);
      const lead = phone.ok ? await findByMobile(phone.mobile, tx) : null;
      const at = m.receivedAt ?? now();
      const pending = !!lead && !lead.anonymizedAt && ENGAGEMENT_STAGES.includes(lead.stage) && (await awaitingReply(lead, at, tx));
      const intent: JobIntent = pending ? readJobIntent(m.text) : "UNCLEAR";
      await tx.inboundMessage.create({
        data: { candidateId: lead?.id ?? null, channel: "WHATSAPP", fromLast4: phone.mobile.slice(-4), body: m.text.slice(0, 4000), intent, providerRef: m.providerRef, receivedAt: at },
      });
      out.stored++;
      if (!lead) out.unmatched++;
      if (!lead || !pending) return;

      const link = `/leads/${lead.id}`;
      const quote = m.text.length > 80 ? `${m.text.slice(0, 77)}…` : m.text;
      if (intent === "LOOKING") {
        await markJobIntent(sys, lead.id, `WhatsApp reply: ${quote}`, tx);
        await notify(lead.ownerUserId, { kind: "LEAD_ASSIGNED", title: `${lead.name} needs a job — now Super active`, body: `Replied on WhatsApp: “${quote}”`, link }, tx, sys);
        out.looking++;
      } else if (intent === "NOT_LOOKING") {
        // Answered (the stored reply ends the wait); the lead stays cold.
        await notify(lead.ownerUserId, { kind: "LEAD_ASSIGNED", title: `${lead.name} is not looking right now`, body: `Replied on WhatsApp: “${quote}”`, link }, tx, sys);
        out.notLooking++;
      } else {
        await ensureOpenTask(sys, { type: "REENGAGE_REPLY", title: `Read WhatsApp reply and confirm job need: “${quote}”`, candidateId: lead.id, assigneeId: lead.ownerUserId, dueAt: at }, tx);
        out.review++;
      }
      await audit(sys, "CONTACT_LOGGED", "candidate", lead.id, { channel: "WHATSAPP", direction: "INBOUND", intent }, tx);
    });
  }
  return out;
}
