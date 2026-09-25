/**
 * KPI formulas (PLAN §6) against a seeded fixture week: Mon 21-09-2026 → Sun 27-09-2026 (IST).
 * Every metric in the registry must have an expected value here (enforced below).
 */
import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { setClock, now, DAY } from "@/lib/clock";
import { setSetting } from "@/lib/settings";
import { SYSTEM } from "@/lib/rbac";
import { periodRange } from "@contracts/shared/dates";
import { KPI_DEFINITIONS, SHEETS, type Sheet } from "@/kpi/definitions";
import { computeSheetTable } from "@/kpi/engine";
import { freezePeriod } from "@/kpi/snapshots";
import { kpiWorkbook } from "@/kpi/export";
import { createCandidate } from "@/modules/candidates/service";
import { transitionLead } from "@/modules/lifecycle/transition";
import { logContact, allocateToTelecaller, logMissedCall, recordRecall } from "@/modules/outreach/service";
import { scrutinize, verifyAndQualify, recordAvailabilityCheck } from "@/modules/scrutiny/service";
import { submitCandidate, decideSubmission } from "@/modules/vacancies/service";
import { scheduleInterview, recordInterviewOutcome, sendOffer, confirmJoiningDate, recordJoining, completeFormalities, recordRetentionCheck } from "@/modules/interviews/service";
import { runImport, autoMap } from "@/modules/import/pipeline";
import { raiseRedFlag, suggestCapa, implementCapa, verifyAndClose } from "@/modules/redflags/service";
import { decrypt } from "@/lib/crypto";
import { resetDb, as, userId, completeProfile } from "./helpers";
import { driveTo, makeVacancy } from "./drive";

const W = periodRange("WEEK", new Date("2026-09-21T04:30:00Z"));
const at = (iso: string) => setClock(iso);
let tables: Record<Sheet, Awaited<ReturnType<typeof computeSheetTable>>>;

async function attendance(key: string, days: number) {
  const id = await userId(key);
  for (let i = 0; i < days; i++) await prisma.attendance.create({ data: { userId: id, date: new Date(Date.UTC(2026, 8, 21 + i)), present: true } });
}

beforeAll(async () => {
  await resetDb();
  await setSetting("cvTargetPerVacancy", 2);
  const pharm = { mainCategory: "PHARMACY" as const, jobTitle: "Pharmacist", primarySpecialty: "Retail" };
  const pharmVac = { category: "PHARMACY" as const, title: "Pharmacist", specialty: "Retail", location: "Hyderabad" };

  // ── P0: chain L joins 23-08, day-7 on 30-08; day-30 falls inside W ──
  at("2026-08-20T04:30:00Z");
  const VP0 = await makeVacancy(pharmVac);
  const L = await driveTo("JOINED", pharm, { vacancyId: VP0.id });
  await completeFormalities(await as("harsha"), L.joiningId!);
  at("2026-08-30T06:00:00Z");
  await recordRetentionCheck(await as("harsha"), L.joiningId!, 7, true, undefined);

  // ── P1: chain J joins 14-09 05:30Z; day-7 falls inside W ──
  at("2026-09-11T04:30:00Z");
  const VPJ = await makeVacancy(pharmVac);
  const J = await driveTo("JOINED", pharm, { vacancyId: VPJ.id });

  // ── P2: prior week (Mon 14-09) ──
  at("2026-09-14T04:30:00Z");
  const V1 = await makeVacancy();
  const VP1 = await makeVacancy(pharmVac);
  const VC1 = await makeVacancy({ category: "ALLIED", title: "Lab technician", specialty: null, location: "Chennai" }, "FREE_TRIAL");
  const A1 = await driveTo("ACTIVE", { source: "NT" });
  const A2 = await driveTo("ACTIVE", { source: "NT" });
  const A5 = await driveTo("ACTIVE", { source: "NAUKRI" });
  const A6 = await driveTo("ACTIVE", { source: "NAUKRI" });
  await driveTo("SOURCED", { source: "NT" }, { vacancyId: V1.id }); // A3
  const A4 = await driveTo("QUALIFIED", { source: "NT" });
  await recordAvailabilityCheck(await as("srividya"), A4.id, false, undefined); // → cold
  const K = await driveTo("SOURCED", pharm, { vacancyId: VP1.id });
  await driveTo("SOURCED", { mainCategory: "ALLIED", jobTitle: "Lab technician", primarySpecialty: "Pathology", preferredLocations: ["Chennai"] }, { vacancyId: VC1.id });
  await prisma.vacancy.updateMany({ where: { id: { in: [V1.id, VP1.id] } }, data: { wasPending: true, status: "PENDING" } });

  // ── W: Mon 21-09 10:00 IST ──
  at("2026-09-21T04:30:00Z");
  const V2 = await makeVacancy(); // before 2 pm
  const VD = await makeVacancy({ category: "DOCTOR", title: "Consultant", specialty: "Cardiology", location: "Bengaluru" }, "EXISTING");
  await makeVacancy({ category: "ALLIED", title: "Dialysis tech", specialty: null, location: "Chennai" }, "FREE_TRIAL"); // VC2

  // Team 1a: Jennifer
  const jen = await as("jennifer");
  const B = [];
  for (let i = 0; i < 4; i++) B.push(await driveTo("VALIDATED"));
  const N1 = await createCandidate(jen, { ...completeProfile({ source: "NAUKRI" }), registrationNumber: null });
  const N2 = await createCandidate(jen, completeProfile({ source: "LINKEDIN" }));
  for (const n of [N1, N2]) await transitionLead(SYSTEM("t"), n.id, "VALIDATED");
  await logContact(jen, B[0].id, { channel: "CALL", outcome: "ENROLLED" });
  await logContact(jen, B[1].id, { channel: "CALL", outcome: "UNANSWERED" });
  await logContact(jen, B[2].id, { channel: "WHATSAPP", outcome: "INTERESTED_LINK_SENT_NOT_REGISTERED" });
  await logContact(jen, B[3].id, { channel: "CALL", outcome: "BUSY_RECALL_REQUESTED" });
  await logContact(jen, N1.id, { channel: "CALL", outcome: "ENROLLED" });
  await scrutinize(await as("srividya"), B[0].id);
  await scrutinize(await as("srividya"), N1.id);
  await verifyAndQualify(await as("dixha"), B[0].id, "ok");

  // Team 1b: Bhavani
  const P = [];
  for (let i = 0; i < 4; i++) P.push(await driveTo("VALIDATED", pharm));
  await allocateToTelecaller(await as("sarala"), [P[0].id, P[1].id, P[2].id], await userId("bhavani"));
  const bh = await as("bhavani");
  await logContact(bh, P[0].id, { channel: "CALL", outcome: "ENROLLED", isFirstTimeVerifiedCall: true });
  await logContact(bh, P[1].id, { channel: "CALL", outcome: "INTERESTED_LINK_SENT_NOT_REGISTERED", isFirstTimeVerifiedCall: true });
  await logContact(bh, P[2].id, { channel: "CALL", outcome: "UNANSWERED", isFirstTimeVerifiedCall: true });
  const p4 = await prisma.candidate.findUniqueOrThrow({ where: { id: P[3].id } });
  const M1 = await logMissedCall(bh, { mobile: decrypt(p4.mobileEnc)! });
  const M2 = await logMissedCall(bh, { mobile: "8000000001" });
  await logMissedCall(bh, { mobile: "8000000002" });
  await recordRecall(bh, M1.id, { answered: true, linkSent: true, enrolled: true });
  await recordRecall(bh, M2.id, { answered: false });

  // Team 2: Sri Vidya — submissions and TAT
  const sv = await as("srividya");
  at("2026-09-21T05:00:00Z");
  await submitCandidate(sv, V2.id, A1.id);
  at("2026-09-21T05:30:00Z");
  await submitCandidate(sv, V2.id, A2.id);
  at("2026-09-21T09:30:00Z"); // 15:00 IST
  const V3 = await makeVacancy({}, "EXISTING");
  at("2026-09-21T10:00:00Z");
  await submitCandidate(sv, V3.id, A5.id);
  at("2026-09-21T10:30:00Z");
  await submitCandidate(sv, V3.id, A6.id);
  at("2026-09-22T04:30:00Z");
  await recordAvailabilityCheck(sv, A4.id, true, undefined); // cold → warm → Active
  await submitCandidate(sv, V1.id, A4.id); // V1 completes (was pending)

  // Mismatched qualified: doctor qualified in W, CV rejected
  const Q1 = await driveTo("ACTIVE", { mainCategory: "DOCTOR", jobTitle: "Consultant", primarySpecialty: "Cardiology", preferredLocations: ["Bengaluru"] });
  const sub = await submitCandidate(await as("dixha"), VD.id, Q1.id);
  await decideSubmission(await as("sampath"), sub.id, "REJECTED");

  // Team 3a: Harsha
  at("2026-09-22T05:00:00Z");
  await recordRetentionCheck(await as("harsha"), J.joiningId!, 7, true, undefined);
  await recordRetentionCheck(await as("harsha"), L.joiningId!, 30, true, undefined); // → Successful, VP0 closes
  const kSub = await prisma.submission.findFirstOrThrow({ where: { candidateId: K.id } });
  const iv = await scheduleInterview(await as("harsha"), kSub.id, { scheduledAt: new Date("2026-09-23T04:30:00Z") });
  at("2026-09-23T06:00:00Z");
  await recordInterviewOutcome(await as("harsha"), iv.id, { status: "ATTENDED", result: "SELECTED" });
  const offer = await sendOffer(await as("harsha"), kSub.id, { ctcLakhs: 5 });
  await confirmJoiningDate(await as("harsha"), offer.id, new Date("2026-09-24T04:30:00Z"));
  at("2026-09-24T04:30:00Z");
  await recordJoining(await as("harsha"), offer.id, now());

  // Team 4: import by Greeshma (3 rows: 1 accepted, 1 duplicate, 1 invalid)
  const rows = [
    { Name: "Dr Kiran", Mobile: "7000000001", Category: "Doctor", "Job Title": "Resident", Location: "Hyderabad" },
    { Name: "Dr Kiran again", Mobile: "7000000001", Category: "Doctor", "Job Title": "Resident", Location: "Hyderabad" },
    { Name: "Short", Mobile: "700000000", Category: "Doctor", "Job Title": "Resident", Location: "Hyderabad" },
  ];
  await runImport(await as("greeshma"), { fileName: "w.xlsx", rows, mapping: autoMap(Object.keys(rows[0])), source: "CONVENTIONAL_MARKETING" });

  // Team 4: red flags by Sumitha
  const co = await as("sumitha");
  at("2026-09-21T04:30:00Z");
  const f1 = await raiseRedFlag(co, { teamCode: "T1A", description: "Low enrolment" });
  const f2 = await raiseRedFlag(co, { teamCode: "T2", description: "TAT breach" });
  await raiseRedFlag(co, { teamCode: "T1B", description: "Recalls pending" });
  for (const f of [f1, f2]) {
    await suggestCapa(co, f.id, { capaSuggested: "Fix", actionOwnerId: await userId("sarala") });
    await implementCapa(await as("sarala"), f.id, { correctiveActionImplemented: "Fixed" });
  }
  at("2026-09-21T10:00:00Z");
  await verifyAndClose(co, f1.id, undefined);
  at("2026-09-24T10:00:00Z");
  await verifyAndClose(co, f2.id, undefined);

  await attendance("jennifer", 5);
  await attendance("bhavani", 4);
  await attendance("srividya", 5);
  await attendance("harsha", 6);

  at("2026-09-28T00:00:00Z");
  tables = {} as typeof tables;
  for (const s of SHEETS) tables[s.sheet] = await computeSheetTable(s.sheet, W.start, W.end);
}, 180_000);

const agentOf: Partial<Record<Sheet, string>> = { T1A: "Jennifer", T1B: "Bhavani", T2: "Sri Vidya", T3A: "Harsha", T3B: "Sampath", T3C: "Sampath" };

const EXPECTED: Record<string, number | null> = {
  // Team 1a — Jennifer
  "t1a.working_days": 5,
  "t1a.validated_assigned": 4,
  "t1a.enrolled_from_validated": 1,
  "t1a.nonnt_downloaded": 2,
  "t1a.enrolled_nonnt": 1,
  "t1a.total_enrolled": 2,
  "t1a.enrolled_screened": 2,
  "t1a.pct_screened": 100,
  "t1a.approved": 1,
  "t1a.pct_approved": 50,
  "t1a.pct_enrolled_from_validated": 25,
  "t1a.pct_enrolled_nonnt": 50,
  "t1a.calls_attempted": 4,
  "t1a.unanswered_calls": 2,
  // Team 1b — Bhavani
  "t1b.working_days": 4,
  "t1b.ftc_allocated": 3,
  "t1b.ftc_attended": 3,
  "t1b.ftc_answered": 2,
  "t1b.ftc_links_sent": 1,
  "t1b.ftc_enrolled": 1,
  "t1b.ftc_attempted_over_allocated": 100,
  "t1b.ftc_answered_over_attempted": 66.7,
  "t1b.ftc_links_over_answered": 50,
  "t1b.ftc_enrolled_over_links": 100,
  "t1b.mc_missed": 3,
  "t1b.mc_recalls": 2,
  "t1b.mc_answered": 1,
  "t1b.mc_links_sent": 1,
  "t1b.mc_enrolled": 1,
  "t1b.mc_recalls_over_missed": 66.7,
  "t1b.mc_answered_over_recalls": 50,
  "t1b.mc_links_over_answered": 100,
  "t1b.mc_enrolled_over_links": 100,
  // Team 2 — Sri Vidya (CV target set to 2 for this fixture)
  "t2.working_days": 5,
  "t2.enrolled_received": 2,
  "t2.scrutinised": 2,
  "t2.qualified": 1,
  "t2.cold_to_warm": 1,
  "t2.open_vacancies": 3,
  "t2.vacancies_worked": 3,
  "t2.vacancies_before_2pm": 1,
  "t2.vacancies_5_nt": 2,
  "t2.vacancies_5_nonnt": 1,
  "t2.closed_pending": 1,
  "t2.avg_tat_minutes": 3880, // (11520 + 60 + 60) / 3
  "t2.pct_scrutiny": 100,
  "t2.pct_qualified": 50,
  "t2.pct_sourced_nt": 66.7,
  "t2.pct_sourced_nonnt": 33.3,
  "t2.avg_cvs_per_vacancy": 1.67,
  // Team 3a — Harsha
  "t3a.working_days": 6,
  "t3a.opening": 4,
  "t3a.new": 1,
  "t3a.pending": 1,
  "t3a.in_hand": 5,
  "t3a.interviews": 1,
  "t3a.offers": 1,
  "t3a.joinings": 1,
  "t3a.retained_7d": 1,
  "t3a.retained_30d": 1,
  "t3a.closures": 1,
  "t3a.rate_interviews": 20,
  "t3a.rate_offers": 20,
  "t3a.rate_joinings": 20,
  "t3a.rate_closures": 20,
  // Team 3b — Sampath
  "t3b.working_days": 0,
  "t3b.opening": 0,
  "t3b.new": 2,
  "t3b.pending": 0,
  "t3b.min2_cvs": 1,
  "t3b.in_hand": 2,
  "t3b.interviews": 0,
  "t3b.offers": 0,
  "t3b.joinings": 0,
  "t3b.retained_7d": 0,
  "t3b.retained_30d": 0,
  "t3b.closures": 0,
  "t3b.rate_interviews": 0,
  "t3b.rate_offers": 0,
  "t3b.rate_joinings": 0,
  "t3b.rate_closures": 0,
  // Team 3c — Sampath
  "t3c.working_days": 0,
  "t3c.opening": 1,
  "t3c.new": 1,
  "t3c.pending": 0,
  "t3c.min2_cvs": 0,
  "t3c.in_hand": 2,
  "t3c.with_cvs": 1,
  "t3c.pct_with_cvs": 50,
  // Team 4 — data analyst (team level)
  "t4da.incomplete_enrolled": 1,
  "t4da.mismatched_qualified": 1,
  "t4da.import_rows": 3,
  "t4da.import_duplicates": 1,
  "t4da.import_invalid": 1,
  "t4da.import_accepted": 1,
  "t4da.funnel_mapping": 12,
  "t4da.funnel_validated": 12,
  "t4da.funnel_enrolled": 5,
  "t4da.funnel_qualified": 2,
  "t4da.funnel_active": 2,
  "t4da.funnel_sourced": 6,
  "t4da.funnel_selected": 1,
  "t4da.funnel_joined": 1,
  "t4da.funnel_successful": 1,
  // Team 4 — coordinator (team level)
  "t4c.flags_t1": 2,
  "t4c.flags_t2": 1,
  "t4c.flags_t3": 0,
  "t4c.closed_within_1wd": 1,
  "t4c.closed_beyond_1wd": 1,
  "t4c.still_open": 1,
};

describe("KPI registry", () => {
  it("has an expected fixture value for every metric", () => {
    const missing = KPI_DEFINITIONS.map((d) => d.key).filter((k) => !(k in EXPECTED));
    expect(missing).toEqual([]);
    const unknown = Object.keys(EXPECTED).filter((k) => !KPI_DEFINITIONS.some((d) => d.key === k));
    expect(unknown).toEqual([]);
  });

  describe.each(KPI_DEFINITIONS.map((d) => [d.key, d] as const))("%s", (key, def) => {
    it(`${def.label} = ${EXPECTED[key]}`, () => {
      const t = tables[def.sheet];
      const agent = agentOf[def.sheet];
      const values = agent ? t.members.find((m) => m.name === agent)!.values : t.team;
      expect(values[key]).toBe(EXPECTED[key]);
    });
  });
});

describe("team totals and snapshots", () => {
  it("team totals recompute ratios from summed bases", () => {
    const t = tables.T1A;
    const sumOf = (k: string) => t.members.reduce((a, m) => a + (m.values[k] ?? 0), 0);
    expect(t.team["t1a.validated_assigned"]).toBe(sumOf("t1a.validated_assigned"));
    expect(t.team["t1a.total_enrolled"]).toBe(sumOf("t1a.total_enrolled"));
    const expectedPct = Math.round((sumOf("t1a.enrolled_from_validated") / sumOf("t1a.validated_assigned")) * 1000) / 10;
    expect(t.team["t1a.pct_enrolled_from_validated"]).toBe(expectedPct);
  });

  it("freezes snapshots and exports the weekly workbook in the sheet layout", async () => {
    const r = await freezePeriod("WEEK", W.start);
    expect(r.rows).toBeGreaterThan(50);
    const snap = await prisma.kpiSnapshot.findFirstOrThrow({ where: { metricKey: "t1a.validated_assigned", userId: await userId("jennifer"), periodType: "WEEK", periodStart: W.start } });
    expect(snap.value).toBe(4);
    const buf = await kpiWorkbook("WEEK", W.start);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toHaveLength(SHEETS.length);
    const ws = wb.worksheets[0];
    expect(ws.getRow(4).values).toContain("Jennifer");
    expect(ws.getRow(4).values).toContain("Team total");
    const labels: string[] = [];
    ws.eachRow((row) => labels.push(String(row.getCell(2).value ?? "")));
    expect(labels).toContain("Red flags noticed");
    expect(labels).toContain("Action taken");
    void DAY;
  });
});
