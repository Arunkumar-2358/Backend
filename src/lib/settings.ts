import { prisma, type Tx } from "./db";
import { DEFAULT_ENGAGEMENT_DAYS } from "@contracts/shared/engagement";

/**
 * Business configuration. Defaults follow PLAN.md §10 assumptions; admins can
 * override any key from Admin → Settings (stored in app_settings).
 */
export const DEFAULT_SETTINGS = {
  /** §10 Q1 — mandatory SOP fields for Enrolled → Qualified */
  mandatorySopFields: [
    "name",
    "mobile",
    "email",
    "basicQualification",
    "registrationNumber",
    "mainCategory",
    "primarySpecialty",
    "experienceYears",
    "preferredLocations",
    "currentCtcLakhs",
    "expectedCtcLakhs",
    "noticePeriodDays",
    "resumeFileKey",
    "consentRecordStoreShare",
  ] as string[],
  /** §10 Q2 — attempts before a lead is marked Unreachable */
  maxContactAttempts: 5,
  /** hours until the automatic follow-up for each outcome */
  followupHours: { UNANSWERED: 24, INTERESTED_LINK_SENT_NOT_REGISTERED: 48, BUSY_RECALL_REQUESTED: 4 } as Record<string, number>,
  availabilityCheckIntervalDays: 60,
  /** Engagement tiers: days since last engaged (visit / job intent) up to which a lead is super active, active, warm; older is cold */
  engagementTierDays: { ...DEFAULT_ENGAGEMENT_DAYS } as Record<string, number>,
  /** Most cold-lead re-engagement WhatsApps sent per day (spreads a backlog out) */
  reengageDailyLimit: 200,
  /** Cold-lead calls (Team 2): attempts before an unanswered lead is given up for this cold spell */
  coldCallMaxAttempts: 3,
  /** hours until an unanswered cold-lead call comes back as a recall */
  coldCallRecallHours: 24,
  cvTargetPerVacancy: 5,
  cvMinTeam3bc: 2,
  interviewReminderOffsetsHours: [24, 2] as number[],
  offerFollowupIntervalHours: 48,
  retentionDays: [7, 30] as number[],
  redFlagSlaWorkingDays: 1,
  enrolmentLinkTemplate: "https://nextenti.ai/register?ref={{code}}",
};

export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;

export async function getSetting<K extends SettingKey>(key: K, db: Tx = prisma): Promise<Settings[K]> {
  const row = await db.appSetting.findUnique({ where: { key } });
  return (row?.value as Settings[K] | undefined) ?? DEFAULT_SETTINGS[key];
}

export async function getAllSettings(db: Tx = prisma): Promise<Settings> {
  const rows = await db.appSetting.findMany();
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const r of rows) if (r.key in out) out[r.key] = r.value;
  return out as Settings;
}

export async function setSetting<K extends SettingKey>(key: K, value: Settings[K], db: Tx = prisma) {
  await db.appSetting.upsert({
    where: { key },
    create: { key, value: value as never },
    update: { value: value as never },
  });
}
