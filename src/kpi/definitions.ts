/**
 * KPI registry (PLAN §6). One entry per metric: key, label, sheet (team), unit,
 * formula and optional default target. Every value is computed from event
 * data — the only manual input is attendance ("working days").
 *
 * Attribution: metrics are credited to the agent who owned / performed the
 * event at the time (lead_stage_history keeps owner snapshots). Team totals are
 * computed with all team members' ids, so ratios are recomputed, never averaged.
 */
import type { Prisma, Stage, TeamCode } from "@prisma/client";
import type { Tx } from "@/lib/db";
import type { Settings } from "@/lib/settings";
import { MINUTE } from "@/lib/clock";
import type { Sheet, Unit } from "@contracts/shared/kpi";

export { SHEETS, formatKpi, type Sheet, type Unit } from "@contracts/shared/kpi";

export type KpiCtx = {
  db: Tx;
  start: Date;
  end: Date;
  /** agents to credit; null = no agent filter (whole organisation) */
  userIds: string[] | null;
  team: TeamCode;
  settings: Settings;
};

export type KpiValue = number | null;

export type KpiDef = {
  key: string;
  label: string;
  sheet: Sheet;
  unit: Unit;
  description: string;
  /** team-level only (no per-agent breakdown) */
  teamOnly?: boolean;
  compute?: (ctx: KpiCtx) => Promise<KpiValue>;
  derive?: (v: Record<string, KpiValue>) => KpiValue;
  defaultTarget?: { value: number; comparator: "gte" | "lte" };
};

// ───────────── helpers ─────────────

const inP = (c: KpiCtx) => ({ gte: c.start, lt: c.end });
const users = (c: KpiCtx, field: string): Record<string, unknown> => (c.userIds ? { [field]: { in: c.userIds } } : {});

/** percentage a / b, null when b is 0 */
export const pct = (a: KpiValue, b: KpiValue): KpiValue => (a === null || b === null || b === 0 ? null : Math.round((a / b) * 1000) / 10);
const sum = (...xs: KpiValue[]): KpiValue => xs.reduce<number>((acc, x) => acc + (x ?? 0), 0);

async function workingDays(c: KpiCtx) {
  return c.db.attendance.count({ where: { present: true, date: inP(c), ...users(c, "userId") } });
}

/** Stage entries in the period, credited via the ownership snapshot. */
function historyWhere(c: KpiCtx, to: Stage, credit: "ownerUserId" | "prevOwnerUserId", extra: Prisma.LeadStageHistoryWhereInput = {}): Prisma.LeadStageHistoryWhereInput {
  return { toStage: to, at: inP(c), ...users(c, credit), ...extra };
}

async function enrolledCohort(c: KpiCtx) {
  const rows = await c.db.leadStageHistory.findMany({
    where: historyWhere(c, "ENROLLED", "prevOwnerUserId", { fromStage: "VALIDATED" }),
    select: { candidateId: true, candidate: { select: { isNtSource: true, scrutinizedAt: true } } },
  });
  const ids = [...new Set(rows.map((r) => r.candidateId))];
  const qualified = ids.length
    ? await c.db.leadStageHistory.findMany({ where: { candidateId: { in: ids }, toStage: "QUALIFIED" }, select: { candidateId: true }, distinct: ["candidateId"] })
    : [];
  return { rows, ids, qualified: new Set(qualified.map((q) => q.candidateId)) };
}

// Vacancy scopes ------------------------------------------------------------

function vacWhere(c: KpiCtx, field: "sourcerId" | "recruiterId", extra: Prisma.VacancyWhereInput = {}): Prisma.VacancyWhereInput {
  const team = field === "recruiterId" ? { routedTeam: c.team } : {};
  return { ...team, ...users(c, field), ...extra };
}
/** vacancies being worked during the period: posted before end, not closed before start */
const workedDuring = (c: KpiCtx): Prisma.VacancyWhereInput => ({ postedAt: { lt: c.end }, OR: [{ closedAt: null }, { closedAt: { gte: c.start } }] });
const openingAtStart = (c: KpiCtx): Prisma.VacancyWhereInput => ({ postedAt: { lt: c.start }, OR: [{ closedAt: null }, { closedAt: { gte: c.start } }] });

async function vacanciesWithSubs(c: KpiCtx, where: Prisma.VacancyWhereInput) {
  return c.db.vacancy.findMany({ where, select: { id: true, submissions: { where: { submittedAt: { lt: c.end } }, select: { isNtSource: true } } } });
}

// ───────────── registry ─────────────

const T1A: KpiDef[] = [
  { key: "t1a.working_days", label: "Working days", sheet: "T1A", unit: "count", description: "Days present (attendance input)", compute: workingDays },
  { key: "t1a.validated_assigned", label: "Validated leads assigned", sheet: "T1A", unit: "count", description: "NT-funnel leads that entered Validated owned by the agent",
    compute: (c) => c.db.leadStageHistory.count({ where: historyWhere(c, "VALIDATED", "ownerUserId", { candidate: { isNtSource: true } }) }) },
  { key: "t1a.enrolled_from_validated", label: "Enrolled from validated", sheet: "T1A", unit: "count", description: "NT-funnel leads moved Validated → Enrolled, credited to the owner while Validated",
    compute: (c) => c.db.leadStageHistory.count({ where: historyWhere(c, "ENROLLED", "prevOwnerUserId", { fromStage: "VALIDATED", candidate: { isNtSource: true } }) }) },
  { key: "t1a.nonnt_downloaded", label: "Non-NT portal leads downloaded", sheet: "T1A", unit: "count", description: "Leads the agent entered from outside portals (Naukri, LinkedIn, Indeed, other)",
    compute: (c) => c.db.candidate.count({ where: { isNtSource: false, createdAt: inP(c), ...users(c, "createdById") } }) },
  { key: "t1a.enrolled_nonnt", label: "Enrolled from non-NT", sheet: "T1A", unit: "count", description: "Non-NT leads moved to Enrolled, credited to the owner",
    compute: (c) => c.db.leadStageHistory.count({ where: historyWhere(c, "ENROLLED", "prevOwnerUserId", { fromStage: "VALIDATED", candidate: { isNtSource: false } }) }) },
  { key: "t1a.total_enrolled", label: "Total enrolled", sheet: "T1A", unit: "count", description: "Enrolled from validated + from non-NT",
    derive: (v) => sum(v["t1a.enrolled_from_validated"], v["t1a.enrolled_nonnt"]) },
  { key: "t1a.enrolled_screened", label: "Enrolled screened by TL", sheet: "T1A", unit: "count", description: "Of the period's enrolments, how many Team 2 has scrutinised",
    compute: async (c) => (await enrolledCohort(c)).rows.filter((r) => r.candidate.scrutinizedAt).length },
  { key: "t1a.pct_screened", label: "% screened by TL", sheet: "T1A", unit: "pct", description: "Screened / total enrolled",
    derive: (v) => pct(v["t1a.enrolled_screened"], v["t1a.total_enrolled"]) },
  { key: "t1a.approved", label: "Approved after scrutiny", sheet: "T1A", unit: "count", description: "Of the period's enrolments, how many reached Qualified",
    compute: async (c) => { const k = await enrolledCohort(c); return k.ids.filter((id) => k.qualified.has(id)).length; } },
  { key: "t1a.pct_approved", label: "% approved", sheet: "T1A", unit: "pct", description: "Approved / screened",
    derive: (v) => pct(v["t1a.approved"], v["t1a.enrolled_screened"]) },
  { key: "t1a.pct_enrolled_from_validated", label: "% enrolled from validated", sheet: "T1A", unit: "pct", description: "Enrolled from validated / validated leads assigned",
    derive: (v) => pct(v["t1a.enrolled_from_validated"], v["t1a.validated_assigned"]), defaultTarget: { value: 20, comparator: "gte" } },
  { key: "t1a.pct_enrolled_nonnt", label: "% enrolled from non-NT", sheet: "T1A", unit: "pct", description: "Enrolled from non-NT / non-NT leads downloaded",
    derive: (v) => pct(v["t1a.enrolled_nonnt"], v["t1a.nonnt_downloaded"]) },
  { key: "t1a.calls_attempted", label: "Calls attempted", sheet: "T1A", unit: "count", description: "Outbound / recall calls logged",
    compute: (c) => c.db.contactAttempt.count({ where: { channel: "CALL", direction: { not: "INBOUND_MISSED" }, at: inP(c), ...users(c, "byUserId") } }) },
  { key: "t1a.unanswered_calls", label: "Unanswered / pending calls", sheet: "T1A", unit: "count", description: "Calls with outcome Unanswered or Busy-recall",
    compute: (c) => c.db.contactAttempt.count({ where: { channel: "CALL", direction: { not: "INBOUND_MISSED" }, outcome: { in: ["UNANSWERED", "BUSY_RECALL_REQUESTED"] }, at: inP(c), ...users(c, "byUserId") } }) },
];

async function firstCalls(c: KpiCtx) {
  return c.db.contactAttempt.findMany({ where: { isFirstTimeVerifiedCall: true, at: inP(c), ...users(c, "byUserId") }, select: { candidateId: true, outcome: true, linkSent: true } });
}

const T1B: KpiDef[] = [
  { key: "t1b.working_days", label: "Working days", sheet: "T1B", unit: "count", description: "Days present (attendance input)", compute: workingDays },
  { key: "t1b.ftc_allocated", label: "Verified first-time calls allocated", sheet: "T1B", unit: "count", description: "First-time call tasks allocated to the tele-caller",
    compute: (c) => c.db.task.count({ where: { refType: "first_call", createdAt: inP(c), ...users(c, "assigneeId") } }) },
  { key: "t1b.ftc_attended", label: "First-time calls attended", sheet: "T1B", unit: "count", description: "First-time verified calls made",
    compute: async (c) => (await firstCalls(c)).length },
  { key: "t1b.ftc_answered", label: "First-time calls answered", sheet: "T1B", unit: "count", description: "First-time calls with any outcome other than Unanswered",
    compute: async (c) => (await firstCalls(c)).filter((a) => a.outcome !== "UNANSWERED").length },
  { key: "t1b.ftc_links_sent", label: "First-time calls: links sent", sheet: "T1B", unit: "count", description: "Enrolment links sent on first-time calls",
    compute: async (c) => (await firstCalls(c)).filter((a) => a.linkSent).length },
  { key: "t1b.ftc_enrolled", label: "First-time calls: enrolled", sheet: "T1B", unit: "count", description: "Distinct leads from first-time calls that reached Enrolled",
    compute: async (c) => {
      const ids = [...new Set((await firstCalls(c)).map((a) => a.candidateId))];
      if (!ids.length) return 0;
      return (await c.db.leadStageHistory.findMany({ where: { candidateId: { in: ids }, toStage: "ENROLLED" }, distinct: ["candidateId"], select: { candidateId: true } })).length;
    } },
  { key: "t1b.ftc_attempted_over_allocated", label: "FTC: attempted / allocated %", sheet: "T1B", unit: "pct", description: "", derive: (v) => pct(v["t1b.ftc_attended"], v["t1b.ftc_allocated"]), defaultTarget: { value: 90, comparator: "gte" } },
  { key: "t1b.ftc_answered_over_attempted", label: "FTC: answered / attempted %", sheet: "T1B", unit: "pct", description: "", derive: (v) => pct(v["t1b.ftc_answered"], v["t1b.ftc_attended"]) },
  { key: "t1b.ftc_links_over_answered", label: "FTC: links / answered %", sheet: "T1B", unit: "pct", description: "", derive: (v) => pct(v["t1b.ftc_links_sent"], v["t1b.ftc_answered"]) },
  { key: "t1b.ftc_enrolled_over_links", label: "FTC: enrolled / links %", sheet: "T1B", unit: "pct", description: "", derive: (v) => pct(v["t1b.ftc_enrolled"], v["t1b.ftc_links_sent"]) },
  { key: "t1b.mc_missed", label: "Missed incoming calls", sheet: "T1B", unit: "count", description: "Missed calls routed to the tele-caller",
    compute: (c) => c.db.missedCall.count({ where: { receivedAt: inP(c), ...users(c, "assignedToId") } }) },
  { key: "t1b.mc_recalls", label: "Recalls attempted", sheet: "T1B", unit: "count", description: "Missed calls recalled",
    compute: (c) => c.db.missedCall.count({ where: { receivedAt: inP(c), recallAttemptedAt: { not: null }, ...users(c, "assignedToId") } }) },
  { key: "t1b.mc_answered", label: "Recalls answered", sheet: "T1B", unit: "count", description: "",
    compute: (c) => c.db.missedCall.count({ where: { receivedAt: inP(c), answered: true, ...users(c, "assignedToId") } }) },
  { key: "t1b.mc_links_sent", label: "Recalls: links sent", sheet: "T1B", unit: "count", description: "",
    compute: (c) => c.db.missedCall.count({ where: { receivedAt: inP(c), linkSent: true, ...users(c, "assignedToId") } }) },
  { key: "t1b.mc_enrolled", label: "Recalls: enrolled", sheet: "T1B", unit: "count", description: "",
    compute: (c) => c.db.missedCall.count({ where: { receivedAt: inP(c), enrolled: true, ...users(c, "assignedToId") } }) },
  { key: "t1b.mc_recalls_over_missed", label: "MC: recalls / missed %", sheet: "T1B", unit: "pct", description: "", derive: (v) => pct(v["t1b.mc_recalls"], v["t1b.mc_missed"]), defaultTarget: { value: 95, comparator: "gte" } },
  { key: "t1b.mc_answered_over_recalls", label: "MC: answered / recalls %", sheet: "T1B", unit: "pct", description: "", derive: (v) => pct(v["t1b.mc_answered"], v["t1b.mc_recalls"]) },
  { key: "t1b.mc_links_over_answered", label: "MC: links / answered %", sheet: "T1B", unit: "pct", description: "", derive: (v) => pct(v["t1b.mc_links_sent"], v["t1b.mc_answered"]) },
  { key: "t1b.mc_enrolled_over_links", label: "MC: enrolled / links %", sheet: "T1B", unit: "pct", description: "", derive: (v) => pct(v["t1b.mc_enrolled"], v["t1b.mc_links_sent"]) },
];

const T2: KpiDef[] = [
  { key: "t2.working_days", label: "Working days", sheet: "T2", unit: "count", description: "Days present (attendance input)", compute: workingDays },
  { key: "t2.enrolled_received", label: "Enrolled leads received", sheet: "T2", unit: "count", description: "Leads routed to the sourcer on entering Enrolled",
    compute: (c) => c.db.leadStageHistory.count({ where: historyWhere(c, "ENROLLED", "ownerUserId") }) },
  { key: "t2.scrutinised", label: "Enrolled leads scrutinised", sheet: "T2", unit: "count", description: "Enrolled leads scrutinised in the period",
    compute: (c) => c.db.candidate.count({ where: { scrutinizedAt: inP(c), ...users(c, "scrutinizedById") } }) },
  { key: "t2.qualified", label: "Qualified leads", sheet: "T2", unit: "count", description: "Leads moved Enrolled → Qualified, credited to the owning sourcer",
    compute: (c) => c.db.leadStageHistory.count({ where: historyWhere(c, "QUALIFIED", "prevOwnerUserId") }) },
  { key: "t2.cold_to_warm", label: "Cold → warm conversions", sheet: "T2", unit: "count", description: "Cold leads that confirmed availability",
    compute: (c) => c.db.availabilityCheck.count({ where: { available: true, wasCold: true, checkedAt: inP(c), ...users(c, "byUserId") } }) },
  { key: "t2.open_vacancies", label: "Open vacancies in hand", sheet: "T2", unit: "count", description: "Vacancies open at the end of the period",
    compute: (c) => c.db.vacancy.count({ where: vacWhere(c, "sourcerId", { postedAt: { lt: c.end }, OR: [{ closedAt: null }, { closedAt: { gte: c.end } }] }) }) },
  { key: "t2.vacancies_worked", label: "Vacancies worked", sheet: "T2", unit: "count", description: "Vacancies open at any point in the period",
    compute: (c) => c.db.vacancy.count({ where: vacWhere(c, "sourcerId", workedDuring(c)) }) },
  { key: "t2.vacancies_before_2pm", label: "Vacancies added before 2 pm", sheet: "T2", unit: "count", description: "Vacancies posted in the period before 14:00 IST",
    compute: (c) => c.db.vacancy.count({ where: vacWhere(c, "sourcerId", { postedAt: inP(c), addedBefore2pm: true }) }) },
  { key: "t2.vacancies_5_nt", label: "Vacancies with 5 CVs from NT", sheet: "T2", unit: "count", description: "Worked vacancies with ≥ target NT-sourced CVs",
    compute: async (c) => (await vacanciesWithSubs(c, vacWhere(c, "sourcerId", workedDuring(c)))).filter((v) => v.submissions.filter((s) => s.isNtSource).length >= c.settings.cvTargetPerVacancy).length },
  { key: "t2.vacancies_5_nonnt", label: "Vacancies with 5 CVs from non-NT", sheet: "T2", unit: "count", description: "Worked vacancies with ≥ target non-NT CVs",
    compute: async (c) => (await vacanciesWithSubs(c, vacWhere(c, "sourcerId", workedDuring(c)))).filter((v) => v.submissions.filter((s) => !s.isNtSource).length >= c.settings.cvTargetPerVacancy).length },
  { key: "t2.closed_pending", label: "Closed pending vacancies", sheet: "T2", unit: "count", description: "Previously pending vacancies whose sourcing completed in the period",
    compute: (c) => c.db.vacancy.count({ where: vacWhere(c, "sourcerId", { wasPending: true, sourcingCompletedAt: inP(c) }) }) },
  { key: "t2.avg_tat_minutes", label: "Average TAT (minutes)", sheet: "T2", unit: "minutes", description: "Posting → 5th CV, for vacancies completed in the period",
    compute: async (c) => {
      const vs = await c.db.vacancy.findMany({ where: vacWhere(c, "sourcerId", { sourcingCompletedAt: inP(c) }), select: { postedAt: true, sourcingCompletedAt: true } });
      if (!vs.length) return null;
      return Math.round(vs.reduce((a, v) => a + (v.sourcingCompletedAt!.getTime() - v.postedAt.getTime()) / MINUTE, 0) / vs.length);
    }, defaultTarget: { value: 240, comparator: "lte" } },
  { key: "t2.pct_scrutiny", label: "% scrutiny", sheet: "T2", unit: "pct", description: "Scrutinised / enrolled received", derive: (v) => pct(v["t2.scrutinised"], v["t2.enrolled_received"]), defaultTarget: { value: 90, comparator: "gte" } },
  { key: "t2.pct_qualified", label: "% qualified out of enrolled", sheet: "T2", unit: "pct", description: "Qualified / enrolled received", derive: (v) => pct(v["t2.qualified"], v["t2.enrolled_received"]) },
  { key: "t2.pct_sourced_nt", label: "% vacancies sourced from NT", sheet: "T2", unit: "pct", description: "Vacancies with 5 NT CVs / vacancies worked", derive: (v) => pct(v["t2.vacancies_5_nt"], v["t2.vacancies_worked"]) },
  { key: "t2.pct_sourced_nonnt", label: "% vacancies sourced from non-NT", sheet: "T2", unit: "pct", description: "Vacancies with 5 non-NT CVs / vacancies worked", derive: (v) => pct(v["t2.vacancies_5_nonnt"], v["t2.vacancies_worked"]) },
  { key: "t2.avg_cvs_per_vacancy", label: "Average sourced CVs per vacancy", sheet: "T2", unit: "avg", description: "CVs submitted in the period / vacancies worked",
    compute: async (c) => {
      const worked = await c.db.vacancy.findMany({ where: vacWhere(c, "sourcerId", workedDuring(c)), select: { id: true } });
      if (!worked.length) return null;
      const n = await c.db.submission.count({ where: { vacancyId: { in: worked.map((w) => w.id) }, submittedAt: inP(c) } });
      return Math.round((n / worked.length) * 100) / 100;
    } },
];

function team3(sheet: "T3A" | "T3B" | "T3C"): KpiDef[] {
  const p = sheet.toLowerCase();
  const inHand = (c: KpiCtx) => vacWhere(c, "recruiterId", workedDuring(c));
  const base: KpiDef[] = [
    { key: `${p}.working_days`, label: "Working days", sheet, unit: "count", description: "Days present (attendance input)", compute: workingDays },
    { key: `${p}.opening`, label: "Opening vacancies", sheet, unit: "count", description: "Vacancies open at the start of the period",
      compute: (c) => c.db.vacancy.count({ where: vacWhere(c, "recruiterId", openingAtStart(c)) }) },
    { key: `${p}.new`, label: "Newly added vacancies", sheet, unit: "count", description: "Vacancies posted in the period",
      compute: (c) => c.db.vacancy.count({ where: vacWhere(c, "recruiterId", { postedAt: inP(c) }) }) },
    { key: `${p}.pending`, label: "Pending vacancies", sheet, unit: "count", description: "Vacancies that went pending and were still unsourced/open at period end",
      compute: (c) => c.db.vacancy.count({ where: vacWhere(c, "recruiterId", { wasPending: true, postedAt: { lt: c.end }, AND: [{ OR: [{ sourcingCompletedAt: null }, { sourcingCompletedAt: { gte: c.end } }] }, { OR: [{ closedAt: null }, { closedAt: { gte: c.end } }] }] }) }) },
  ];
  if (sheet === "T3C") {
    return [
      ...base,
      { key: `${p}.min2_cvs`, label: "Vacancies with ≥2 CVs", sheet, unit: "count", description: "Vacancies in hand with at least the minimum CVs",
        compute: async (c) => (await vacanciesWithSubs(c, inHand(c))).filter((v) => v.submissions.length >= c.settings.cvMinTeam3bc).length },
      { key: `${p}.in_hand`, label: "Vacancies in hand", sheet, unit: "count", description: "Opening + new", derive: (v) => sum(v[`${p}.opening`], v[`${p}.new`]) },
      { key: `${p}.with_cvs`, label: "Vacancies with CVs given", sheet, unit: "count", description: "Vacancies in hand with ≥1 CV",
        compute: async (c) => (await vacanciesWithSubs(c, inHand(c))).filter((v) => v.submissions.length > 0).length },
      { key: `${p}.pct_with_cvs`, label: "% of opening vacancies with CVs given", sheet, unit: "pct", description: "Vacancies with CVs / vacancies in hand",
        derive: (v) => pct(v[`${p}.with_cvs`], v[`${p}.in_hand`]), defaultTarget: { value: 80, comparator: "gte" } },
    ];
  }
  const subOf = (c: KpiCtx) => ({ vacancy: vacWhere(c, "recruiterId") });
  return [
    ...base,
    ...(sheet === "T3B"
      ? [{ key: `${p}.min2_cvs`, label: "Vacancies with ≥2 matching CVs", sheet, unit: "count" as Unit, description: "Vacancies in hand with at least the minimum CVs",
          compute: async (c: KpiCtx) => (await vacanciesWithSubs(c, inHand(c))).filter((v) => v.submissions.length >= c.settings.cvMinTeam3bc).length }]
      : []),
    { key: `${p}.in_hand`, label: "Vacancies in hand (opening + new)", sheet, unit: "count", description: "Denominator for the rates below", derive: (v) => sum(v[`${p}.opening`], v[`${p}.new`]) },
    { key: `${p}.interviews`, label: "Interviews conducted", sheet, unit: "count", description: "Interviews attended in the period",
      compute: (c) => c.db.interview.count({ where: { status: "ATTENDED", scheduledAt: inP(c), submission: subOf(c) } }) },
    { key: `${p}.offers`, label: "Offers given", sheet, unit: "count", description: "Offer letters sent",
      compute: (c) => c.db.offer.count({ where: { sentAt: inP(c), submission: subOf(c) } }) },
    { key: `${p}.joinings`, label: "Joinings", sheet, unit: "count", description: "Candidates who joined",
      compute: (c) => c.db.joining.count({ where: { joinedAt: inP(c), offer: { submission: subOf(c) } } }) },
    { key: `${p}.retained_7d`, label: "7-day retention", sheet, unit: "count", description: "Day-7 checks passed",
      compute: (c) => c.db.joining.count({ where: { retained7dAt: inP(c), offer: { submission: subOf(c) } } }) },
    { key: `${p}.retained_30d`, label: "30-day retention", sheet, unit: "count", description: "Day-30 checks passed (successful placements)",
      compute: (c) => c.db.joining.count({ where: { retained30dAt: inP(c), offer: { submission: subOf(c) } } }) },
    { key: `${p}.closures`, label: "Vacancy closures", sheet, unit: "count", description: "Vacancies closed in the period",
      compute: (c) => c.db.vacancy.count({ where: vacWhere(c, "recruiterId", { closedAt: inP(c) }) }) },
    { key: `${p}.rate_interviews`, label: "Interview rate %", sheet, unit: "pct", description: "Interviews / vacancies in hand", derive: (v) => pct(v[`${p}.interviews`], v[`${p}.in_hand`]) },
    { key: `${p}.rate_offers`, label: "Offer rate %", sheet, unit: "pct", description: "Offers / vacancies in hand", derive: (v) => pct(v[`${p}.offers`], v[`${p}.in_hand`]) },
    { key: `${p}.rate_joinings`, label: "Joining rate %", sheet, unit: "pct", description: "Joinings / vacancies in hand", derive: (v) => pct(v[`${p}.joinings`], v[`${p}.in_hand`]) },
    { key: `${p}.rate_closures`, label: "Closure rate %", sheet, unit: "pct", description: "Closures / vacancies in hand", derive: (v) => pct(v[`${p}.closures`], v[`${p}.in_hand`]), defaultTarget: { value: 10, comparator: "gte" } },
  ];
}

const FUNNEL: Stage[] = ["MAPPING", "VALIDATED", "ENROLLED", "QUALIFIED", "ACTIVE", "SOURCED", "SELECTED", "JOINED", "SUCCESSFUL"];

const T4_DA: KpiDef[] = [
  { key: "t4da.incomplete_enrolled", label: "Incomplete enrolled leads", sheet: "T4_DA", unit: "count", teamOnly: true, description: "Leads enrolled in the period still in Enrolled with an incomplete profile",
    compute: async (c) => {
      const ids = (await c.db.leadStageHistory.findMany({ where: { toStage: "ENROLLED", at: inP(c) }, select: { candidateId: true }, distinct: ["candidateId"] })).map((r) => r.candidateId);
      return c.db.candidate.count({ where: { id: { in: ids }, stage: "ENROLLED", profileCompletenessPct: { lt: 100 } } });
    } },
  { key: "t4da.mismatched_qualified", label: "Mismatched qualified leads", sheet: "T4_DA", unit: "count", teamOnly: true, description: "Leads qualified in the period whose CV a recruiter rejected as not matching",
    compute: async (c) => {
      const ids = (await c.db.leadStageHistory.findMany({ where: { toStage: "QUALIFIED", at: inP(c) }, select: { candidateId: true }, distinct: ["candidateId"] })).map((r) => r.candidateId);
      if (!ids.length) return 0;
      return (await c.db.submission.findMany({ where: { candidateId: { in: ids }, decision: "REJECTED" }, distinct: ["candidateId"], select: { candidateId: true } })).length;
    } },
  { key: "t4da.import_rows", label: "Rows imported", sheet: "T4_DA", unit: "count", description: "Rows in import batches uploaded",
    compute: async (c) => (await c.db.importBatch.aggregate({ where: { createdAt: inP(c), ...users(c, "uploadedById") }, _sum: { totalRows: true } }))._sum.totalRows ?? 0 },
  { key: "t4da.import_duplicates", label: "Duplicates removed", sheet: "T4_DA", unit: "count", description: "",
    compute: async (c) => (await c.db.importBatch.aggregate({ where: { createdAt: inP(c), ...users(c, "uploadedById") }, _sum: { duplicateRows: true } }))._sum.duplicateRows ?? 0 },
  { key: "t4da.import_invalid", label: "Invalid numbers / rows rejected", sheet: "T4_DA", unit: "count", description: "",
    compute: async (c) => (await c.db.importBatch.aggregate({ where: { createdAt: inP(c), ...users(c, "uploadedById") }, _sum: { invalidRows: true } }))._sum.invalidRows ?? 0 },
  { key: "t4da.import_accepted", label: "Accepted (validated) leads", sheet: "T4_DA", unit: "count", description: "",
    compute: async (c) => (await c.db.importBatch.aggregate({ where: { createdAt: inP(c), ...users(c, "uploadedById") }, _sum: { acceptedRows: true } }))._sum.acceptedRows ?? 0 },
  ...FUNNEL.map<KpiDef>((s) => ({
    key: `t4da.funnel_${s.toLowerCase()}`,
    label: `Funnel: entered ${s.charAt(0) + s.slice(1).toLowerCase()}`,
    sheet: "T4_DA",
    unit: "count",
    teamOnly: true,
    description: "Cross-team roll-up of stage entries in the period",
    compute: (c) => c.db.leadStageHistory.count({ where: { toStage: s, at: inP(c) } }),
  })),
];

const flagTeams: Record<string, TeamCode[]> = { t1: ["T1A", "T1B"], t2: ["T2"], t3: ["T3A", "T3B", "T3C"] };

const T4_COORD: KpiDef[] = [
  ...Object.entries(flagTeams).map<KpiDef>(([k, teams]) => ({
    key: `t4c.flags_${k}`,
    label: `Red flags raised – Team ${k.slice(1)}`,
    sheet: "T4_COORD",
    unit: "count",
    description: "",
    compute: (c) => c.db.redFlag.count({ where: { teamCode: { in: teams }, raisedOn: inP(c), ...(c.userIds ? { OR: [{ raisedById: { in: c.userIds } }, { autoRaised: true }] } : {}) } }),
  })),
  { key: "t4c.closed_within_1wd", label: "Closed within 1 working day", sheet: "T4_COORD", unit: "count", description: "Flags raised in the period closed within the SLA",
    compute: (c) => c.db.redFlag.count({ where: { raisedOn: inP(c), closedWithin1WorkingDay: true } }) },
  { key: "t4c.closed_beyond_1wd", label: "Closed beyond 1 working day", sheet: "T4_COORD", unit: "count", description: "Flags raised in the period closed after the SLA",
    compute: (c) => c.db.redFlag.count({ where: { raisedOn: inP(c), closedWithin1WorkingDay: false } }) },
  { key: "t4c.still_open", label: "Still open", sheet: "T4_COORD", unit: "count", description: "Flags raised in the period not yet closed",
    compute: (c) => c.db.redFlag.count({ where: { raisedOn: inP(c), status: { not: "CLOSED" } } }) },
];

export const KPI_DEFINITIONS: KpiDef[] = [...T1A, ...T1B, ...T2, ...team3("T3A"), ...team3("T3B"), ...team3("T3C"), ...T4_DA, ...T4_COORD];

export const KPI_BY_KEY: Record<string, KpiDef> = Object.fromEntries(KPI_DEFINITIONS.map((d) => [d.key, d]));

export function metricsFor(sheet: Sheet): KpiDef[] {
  return KPI_DEFINITIONS.filter((d) => d.sheet === sheet);
}
