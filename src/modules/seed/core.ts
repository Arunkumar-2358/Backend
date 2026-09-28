import bcrypt from "bcryptjs";
import type { MainCategory, PrismaClient, Role, TeamCode } from "@prisma/client";
import { KPI_DEFINITIONS } from "@/kpi/definitions";
import { PRESETS } from "@contracts/shared/import-presets";
import { DEFAULT_CRITERIA, saveTemplate } from "@/modules/eval/service";
import { SYSTEM } from "@/lib/rbac";

export const DEV_PASSWORD = "Nextenti@123";

export const TEAMS: { code: TeamCode; name: string }[] = [
  { code: "T1A", name: "Team 1a – TA Leads" },
  { code: "T1B", name: "Team 1b – Communication centre" },
  { code: "T2", name: "Team 2 – Talent Sourcers" },
  { code: "T3A", name: "Team 3a – Recruitment (general)" },
  { code: "T3B", name: "Team 3b – Recruitment (existing clients)" },
  { code: "T3C", name: "Team 3c – Recruitment (free-trial orgs)" },
  { code: "T4", name: "Team 4 – Data & coordination" },
];

type SeedUser = { key: string; name: string; grants: { team: TeamCode; role: Role; category?: MainCategory }[] };

/** Real team names from the sheet (PLAN §2). */
export const USERS: SeedUser[] = [
  { key: "admin", name: "Admin", grants: [{ team: "T4", role: "admin" }] },
  { key: "greeshma", name: "Greeshma", grants: [{ team: "T4", role: "data_analyst" }] },
  { key: "sumitha", name: "Sumitha", grants: [{ team: "T4", role: "ta_coordinator" }] },
  { key: "sarala", name: "Sarala", grants: [{ team: "T1A", role: "team1_leader" }, { team: "T1B", role: "team1_leader" }] },
  { key: "jennifer", name: "Jennifer", grants: [{ team: "T1A", role: "ta_lead", category: "NURSE" }] },
  { key: "poojitha", name: "Poojitha", grants: [{ team: "T1A", role: "ta_lead", category: "PHARMACY" }] },
  { key: "mounika", name: "Mounika", grants: [{ team: "T1A", role: "ta_lead", category: "DOCTOR" }] },
  { key: "shivani", name: "Shivani", grants: [{ team: "T1A", role: "ta_lead", category: "DOCTOR" }] },
  { key: "shravya", name: "Shravya", grants: [{ team: "T1A", role: "ta_lead", category: "OTHER" }] },
  { key: "bhavani", name: "Bhavani", grants: [{ team: "T1B", role: "telecaller" }] },
  { key: "punitha", name: "Punitha", grants: [{ team: "T1B", role: "telecaller" }] },
  { key: "devi", name: "Devi", grants: [{ team: "T1B", role: "telecaller" }] },
  { key: "dixha", name: "Dixha", grants: [{ team: "T2", role: "team2_leader" }] },
  { key: "srividya", name: "Sri Vidya", grants: [{ team: "T2", role: "sourcer", category: "NURSE" }] },
  { key: "amos", name: "Amos", grants: [{ team: "T2", role: "sourcer", category: "PHARMACY" }] },
  { key: "bhavya", name: "Bhavya", grants: [{ team: "T2", role: "sourcer", category: "DOCTOR" }] },
  { key: "sanjay", name: "Sanjay", grants: [{ team: "T3A", role: "team3_leader" }, { team: "T3B", role: "team3_leader" }, { team: "T3C", role: "team3_leader" }] },
  { key: "harsha", name: "Harsha", grants: [{ team: "T3A", role: "recruiter" }] },
  { key: "sampath", name: "Sampath", grants: [{ team: "T3B", role: "recruiter" }, { team: "T3C", role: "recruiter" }] },
];

export const emailFor = (key: string) => `${key}@nextenti.ai`;

/** Routing rules (configurable in Admin → Assignment rules). */
const RULES: { team: TeamCode; category: MainCategory | null; user: string; priority?: number }[] = [
  { team: "T1A", category: "NURSE", user: "jennifer" },
  { team: "T1A", category: "PHARMACY", user: "poojitha" },
  { team: "T1A", category: "DOCTOR", user: "mounika" },
  { team: "T1A", category: "DOCTOR", user: "shivani" },
  { team: "T1A", category: "ALLIED", user: "shravya" },
  { team: "T1A", category: "ADMIN", user: "shravya" },
  { team: "T1A", category: "OTHER", user: "shravya" },
  { team: "T1A", category: null, user: "shravya" },
  { team: "T2", category: "NURSE", user: "srividya" },
  { team: "T2", category: "OTHER", user: "srividya" },
  { team: "T2", category: "ADMIN", user: "srividya" },
  { team: "T2", category: "PHARMACY", user: "amos" },
  { team: "T2", category: "ALLIED", user: "amos" },
  { team: "T2", category: "DOCTOR", user: "bhavya" },
  { team: "T2", category: null, user: "srividya" },
  { team: "T3A", category: null, user: "harsha" },
  { team: "T3B", category: null, user: "sampath" },
  { team: "T3C", category: null, user: "sampath" },
];

export const TEMPLATES = [
  { key: "enrolment_link_whatsapp", name: "Enrolment link (WhatsApp)", channel: "WHATSAPP", body: "Hi {{name}}, greetings from Nextenti! Healthcare roles matching your profile are open. Register in 2 minutes to get matched: {{link}}" },
  { key: "enrolment_link_sms", name: "Enrolment link (SMS)", channel: "SMS", body: "Nextenti: Hi {{name}}, register to get matched to healthcare jobs: {{link}}" },
  { key: "enrolment_link_email", name: "Enrolment link (email)", channel: "EMAIL", subject: "Complete your Nextenti profile", body: "Dear {{name}},\n\nThank you for your interest in Nextenti. Please complete your registration so we can match you with the right healthcare opportunities:\n{{link}}\n\nTeam Nextenti" },
  { key: "interview_scheduled", name: "Interview scheduled", channel: "WHATSAPP", body: "Hi {{name}}, your interview for {{role}} at {{org}} is fixed for {{interviewAt}} IST. Please confirm by replying YES. – Nextenti" },
  { key: "interview_reminder", name: "Interview reminder", channel: "WHATSAPP", body: "Reminder: your interview for {{role}} at {{org}} is at {{interviewAt}} IST (in {{hoursBefore}} hours). All the best! – Nextenti" },
  { key: "offer_sent", name: "Offer letter sent (email)", channel: "EMAIL", subject: "Your offer for {{role}}", body: "Dear {{name}},\n\nCongratulations! Your offer letter for {{role}} has been shared. Please confirm your joining date.\n\nTeam Nextenti" },
  { key: "offer_sent_whatsapp", name: "Offer letter sent (WhatsApp)", channel: "WHATSAPP", body: "Congratulations {{name}}! Your offer for {{role}} has been shared. Please confirm your joining date. – Nextenti" },
  { key: "invite_to_apply_whatsapp", name: "Invite to apply (WhatsApp)", channel: "WHATSAPP", body: "Hi {{name}}, a {{role}} role at {{org}}, {{location}} matches your profile. Reply YES to apply. – Nextenti" },
  { key: "invite_to_apply_sms", name: "Invite to apply (SMS)", channel: "SMS", body: "Nextenti: {{role}} at {{org}}, {{location}} matches your profile. Reply YES to apply." },
  { key: "reengage_cold_whatsapp", name: "Cold lead re-engagement (WhatsApp)", channel: "WHATSAPP", body: "Hi {{name}}, it's been a while since you visited Nextenti. Are you looking for a healthcare job right now? Reply YES if you need a job, or NO if not. – Nextenti" },
  { key: "invite_to_apply_email", name: "Invite to apply (email)", channel: "EMAIL", subject: "{{role}} at {{org}}", body: "Dear {{name}},\n\nA {{role}} opening at {{org}} ({{location}}) matches your profile. Reply to this email to apply.\n\nTeam Nextenti" },
] as const;

export const HOLIDAYS_2026_27 = [
  ["2026-01-26", "Republic Day"],
  ["2026-08-15", "Independence Day"],
  ["2026-10-02", "Gandhi Jayanti"],
  ["2026-12-25", "Christmas"],
  ["2027-01-01", "New Year's Day"],
  ["2027-01-26", "Republic Day"],
] as const;

/**
 * `passwordFor` gives each NEW user their initial password (existing users' passwords are never touched).
 * Defaults to the shared DEV_PASSWORD, which is public in this repo — production must pass a generator.
 */
export async function seedCore(db: PrismaClient, opts: { fastHash?: boolean; passwordFor?: (key: string) => string } = {}) {
  const devHash = await bcrypt.hash(DEV_PASSWORD, opts.fastHash ? 4 : 10);
  const teams: Record<string, string> = {};
  for (const t of TEAMS) teams[t.code] = (await db.team.upsert({ where: { code: t.code }, create: t, update: { name: t.name } })).id;

  const users: Record<string, string> = {};
  for (const u of USERS) {
    const hash = opts.passwordFor ? await bcrypt.hash(opts.passwordFor(u.key), 10) : devHash;
    const user = await db.user.upsert({ where: { email: emailFor(u.key) }, create: { email: emailFor(u.key), name: u.name, passwordHash: hash }, update: { name: u.name } });
    users[u.key] = user.id;
    for (const g of u.grants) {
      await db.userTeamRole.upsert({
        where: { userId_teamId_role: { userId: user.id, teamId: teams[g.team], role: g.role } },
        create: { userId: user.id, teamId: teams[g.team], role: g.role, category: g.category },
        update: { category: g.category },
      });
    }
  }

  if (!(await db.assignmentRule.count())) {
    for (const r of RULES) await db.assignmentRule.create({ data: { teamCode: r.team, category: r.category, userId: users[r.user], priority: r.priority ?? 0 } });
  }

  for (const t of TEMPLATES) {
    await db.messageTemplate.upsert({ where: { key: t.key }, create: { ...t, subject: "subject" in t ? t.subject : null }, update: {} });
  }

  for (const [name, mapping] of Object.entries(PRESETS)) {
    await db.importMapping.upsert({ where: { name }, create: { name, mapping, isPreset: true }, update: { mapping, isPreset: true } });
  }

  for (const [date, name] of HOLIDAYS_2026_27) {
    await db.holiday.upsert({ where: { date: new Date(`${date}T00:00:00Z`) }, create: { date: new Date(`${date}T00:00:00Z`), name }, update: { name } });
  }

  // Default KPI targets (PLAN §10 Q3 — to be confirmed by the business)
  const teamOfSheet: Record<string, TeamCode> = { T1A: "T1A", T1B: "T1B", T2: "T2", T3A: "T3A", T3B: "T3B", T3C: "T3C", T4_DA: "T4", T4_COORD: "T4" };
  for (const d of KPI_DEFINITIONS) {
    if (!d.defaultTarget) continue;
    for (const periodType of ["WEEK", "MONTH"] as const) {
      await db.kpiTarget.upsert({
        where: { metricKey_teamCode_periodType: { metricKey: d.key, teamCode: teamOfSheet[d.sheet], periodType } },
        create: { metricKey: d.key, teamCode: teamOfSheet[d.sheet], periodType, target: d.defaultTarget.value, comparator: d.defaultTarget.comparator },
        update: {},
      });
    }
  }

  if (!(await db.evalTemplate.count())) {
    await saveTemplate(SYSTEM("seed"), { name: "Employee grading template", description: "Default weighted scorecard from the grading sheet", criteria: DEFAULT_CRITERIA }, db);
  }

  const orgs = [
    { name: "Sunrise Multispeciality Hospital", type: "GENERAL", city: "Hyderabad" },
    { name: "CareWell Hospitals", type: "EXISTING", city: "Bengaluru" },
    { name: "MedTrial Clinics", type: "FREE_TRIAL", city: "Chennai" },
  ] as const;
  for (const o of orgs) await db.clientOrg.upsert({ where: { name: o.name }, create: o, update: {} });

  return { users, teams };
}
