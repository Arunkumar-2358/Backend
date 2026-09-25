/**
 * Demo data built through the real services (so history, tasks, jobs and KPIs
 * are all consistent). Events are spread over the last ~3 weeks via the clock.
 */
import type { MainCategory, LeadSource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { setClock, now, DAY, HOUR } from "@/lib/clock";
import { loadActor } from "@/lib/actor";
import { SYSTEM, type Actor } from "@/lib/rbac";
import { startOfIstWeek } from "@contracts/shared/dates";
import { emailFor } from "./core";
import { runImport, autoMap } from "@/modules/import/pipeline";
import { logContact, allocateToTelecaller, logMissedCall, recordRecall } from "@/modules/outreach/service";
import { scrutinize, verifyAndQualify, recordAvailabilityCheck } from "@/modules/scrutiny/service";
import { updateCandidate, decryptCandidate } from "@/modules/candidates/service";
import { createVacancy, submitCandidate, matchesFor } from "@/modules/vacancies/service";
import { scheduleInterview, recordInterviewOutcome, sendOffer, confirmJoiningDate, recordJoining, completeFormalities } from "@/modules/interviews/service";
import { createEvaluation, saveScores, templateLeaves } from "@/modules/eval/service";
import { raiseRedFlag, suggestCapa } from "@/modules/redflags/service";
import { setAdapters, MemoryAdapter } from "@/modules/messaging/adapters";

const FIRST = ["Aarthi", "Bhargav", "Chitra", "Deepak", "Divya", "Ganesh", "Harini", "Imran", "Janani", "Karthik", "Lakshmi", "Manoj", "Nandini", "Pradeep", "Rekha", "Sai", "Swathi", "Tarun", "Uma", "Vikram", "Yamini", "Anjali", "Ravi", "Sneha", "Farhan", "Keerthi", "Naveen", "Pooja", "Suresh", "Meena", "Arjun", "Bindu", "Chaitanya", "Durga", "Esther", "Gopal", "Hema", "Jaya", "Kiran", "Latha"];
const LAST = ["Reddy", "Nair", "Iyer", "Sharma", "Rao", "Menon", "Pillai", "Das", "Khan", "Varma", "Naidu", "Joseph"];
const CITIES = ["Hyderabad", "Bengaluru", "Chennai", "Vijayawada", "Visakhapatnam", "Kochi", "Pune"];
const PROFILES: { cat: MainCategory; title: string; spec: string[]; qual: string; auth: string }[] = [
  { cat: "NURSE", title: "Staff Nurse", spec: ["ICU", "OT", "Emergency", "NICU", "Dialysis"], qual: "B.Sc Nursing", auth: "State Nursing Council" },
  { cat: "PHARMACY", title: "Pharmacist", spec: ["Retail", "Hospital pharmacy", "Clinical"], qual: "B.Pharm", auth: "State Pharmacy Council" },
  { cat: "DOCTOR", title: "Consultant", spec: ["Cardiology", "General Medicine", "Paediatrics", "Anaesthesia"], qual: "MBBS, MD", auth: "State Medical Council" },
  { cat: "ALLIED", title: "Lab Technician", spec: ["Pathology", "Radiology", "Physiotherapy"], qual: "DMLT", auth: "Paramedical Board" },
];

async function actor(key: string): Promise<Actor> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email: emailFor(key) } });
  return (await loadActor(u.id))!;
}

export async function seedDemo() {
  setAdapters({ WHATSAPP: new MemoryAdapter(), SMS: new MemoryAdapter(), EMAIL: new MemoryAdapter() });
  const realNow = new Date();
  const weekStart = startOfIstWeek(realNow);
  const t0 = new Date(weekStart.getTime() - 14 * DAY + 4.5 * HOUR); // Monday two weeks ago, 10:00 IST
  setClock(t0);
  let i = 0;
  const rows = [];
  for (const p of PROFILES) {
    for (let k = 0; k < 14; k++, i++) {
      const city = CITIES[i % CITIES.length];
      const sources: LeadSource[] = ["CONVENTIONAL_MARKETING", "DIGITAL_MARKETING", "NT", "NAUKRI", "LINKEDIN"];
      rows.push({
        "Candidate Name": `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
        "Mobile No": `+91 9${String(800000000 + i * 7919).slice(0, 9)}`,
        "Email ID": `${FIRST[i % FIRST.length].toLowerCase()}.${i}@example.com`,
        "Main Category": p.cat,
        "Job Title": p.title,
        "Primary Specialty": p.spec[k % p.spec.length],
        "Basic Qualification": p.qual,
        "Registration Number": k % 5 === 4 ? "" : `REG-${10000 + i}`,
        "Registration Authority": p.auth,
        "Experience (Years)": 1 + (k % 9),
        "Current Location": city,
        "Preferred Locations": `${city}, ${CITIES[(i + 2) % CITIES.length]}`,
        "Current CTC (Lakhs)": p.cat === "DOCTOR" ? 18 + k : 3 + (k % 5) * 0.6,
        "Expected CTC (Lakhs)": p.cat === "DOCTOR" ? 22 + k : 3.8 + (k % 5) * 0.7,
        "Notice Period (Days)": [15, 30, 30, 60, 90][k % 5],
        Source: sources[k % sources.length],
        Consent: k % 6 === 5 ? "No" : "Yes",
      });
    }
  }
  // a few bad rows so the batch report has content
  rows.push({ ...rows[0], "Candidate Name": "Duplicate Row" });
  rows.push({ ...rows[1], "Candidate Name": "Short Number", "Mobile No": "98480123" });
  rows.push({ ...rows[2], "Candidate Name": "No Location", "Mobile No": "9000011111", "Current Location": "", "Preferred Locations": "", "Email ID": "noloc@example.com" });

  const greeshma = await actor("greeshma");
  await runImport(greeshma, { fileName: "cv-register-demo.xlsx", rows, mapping: autoMap(Object.keys(rows[0])), source: "CONVENTIONAL_MARKETING" });

  // Everyone with a complete profile gets a resume placeholder
  const leads = await prisma.candidate.findMany({ where: { stage: "VALIDATED" }, orderBy: { candidateCode: "asc" } });
  for (const [n, c] of leads.entries()) {
    if (n % 6 !== 5) await prisma.candidate.update({ where: { id: c.id }, data: { resumeFileKey: "demo/resume.pdf", resumeFileName: "resume.pdf" } });
  }

  // Outreach over the first week
  const outcomes = ["ENROLLED", "ENROLLED", "INTERESTED_LINK_SENT_NOT_REGISTERED", "UNANSWERED", "BUSY_RECALL_REQUESTED", "ENROLLED", "NOT_INTERESTED", "ENROLLED"] as const;
  for (const [n, c] of leads.entries()) {
    setClock(new Date(t0.getTime() + (n % 5) * DAY + (n % 7) * HOUR));
    const owner = await loadActor(c.ownerUserId!);
    if (!owner) continue;
    const outcome = outcomes[n % outcomes.length];
    if (n % 9 === 8) continue; // untouched
    await logContact(owner, c.id, { channel: n % 3 === 0 ? "WHATSAPP" : "CALL", outcome });
  }

  // Tele-caller allocation + missed calls
  setClock(new Date(t0.getTime() + 7 * DAY));
  const sarala = await actor("sarala");
  const stillValidated = await prisma.candidate.findMany({ where: { stage: "VALIDATED" }, take: 6 });
  const tele = ["bhavani", "punitha", "devi"];
  for (const [n, c] of stillValidated.entries()) {
    const tc = await actor(tele[n % 3]);
    await allocateToTelecaller(sarala, [c.id], tc.kind === "user" ? tc.id : "");
    await logContact(tc, c.id, { channel: "CALL", outcome: n % 2 ? "ENROLLED" : "INTERESTED_LINK_SENT_NOT_REGISTERED", isFirstTimeVerifiedCall: true });
  }
  const bh = await actor("bhavani");
  const mc1 = await logMissedCall(bh, { mobile: "9123400001" });
  await logMissedCall(bh, { mobile: "9123400002" });
  await recordRecall(bh, mc1.id, { answered: true, linkSent: true, notes: "Asked for nursing jobs in Chennai", newLead: { name: "Walk-in Caller", mainCategory: "NURSE", currentLocation: "Chennai", jobTitle: "Staff Nurse" } });

  // Team 2 scrutiny and qualification
  const dixha = await actor("dixha");
  const enrolled = await prisma.candidate.findMany({ where: { stage: "ENROLLED" } });
  for (const [n, c] of enrolled.entries()) {
    setClock(new Date(t0.getTime() + 8 * DAY + n * HOUR));
    const owner = (await loadActor(c.ownerUserId!))!;
    await scrutinize(owner, c.id);
    const plain = decryptCandidate(await prisma.candidate.findUniqueOrThrow({ where: { id: c.id } }));
    if (plain.profileCompletenessPct < 100 && n % 2 === 0) {
      await updateCandidate(owner, c.id, { registrationNumber: plain.registrationNumber ?? `REG-${n}-FIX`, resumeFileKey: plain.resumeFileKey ?? "demo/resume.pdf", consentRecordStoreShare: true });
    }
    try {
      await verifyAndQualify(dixha, c.id, "Profile verified");
    } catch {
      /* incomplete ones stay in scrutiny */
    }
  }
  const qualified = await prisma.candidate.findMany({ where: { stage: "QUALIFIED" } });
  for (const [n, c] of qualified.entries()) {
    const owner = (await loadActor(c.ownerUserId!))!;
    await recordAvailabilityCheck(owner, c.id, n % 4 !== 3, n % 4 === 3 ? "Not looking this quarter" : undefined);
  }

  // Vacancies (a mix of org types) and matching
  setClock(new Date(weekStart.getTime() - 5 * DAY + 5 * HOUR));
  const orgs = await prisma.clientOrg.findMany();
  const org = (t: string) => orgs.find((o) => o.type === t)!.id;
  const vacs = [
    await createVacancy(dixha, { clientOrgId: org("GENERAL"), title: "Staff Nurse – ICU", category: "NURSE", specialty: "ICU", location: "Hyderabad", minExperienceYears: 2, ctcMaxLakhs: 6, maxNoticeDays: 30, openings: 2 }),
    await createVacancy(dixha, { clientOrgId: org("EXISTING"), title: "Hospital Pharmacist", category: "PHARMACY", specialty: "Hospital pharmacy", location: "Bengaluru", minExperienceYears: 1, ctcMaxLakhs: 5, maxNoticeDays: 30, openings: 1 }),
    await createVacancy(dixha, { clientOrgId: org("FREE_TRIAL"), title: "Consultant Cardiologist", category: "DOCTOR", specialty: "Cardiology", location: "Chennai", minExperienceYears: 3, ctcMaxLakhs: 35, openings: 1 }),
    await createVacancy(dixha, { clientOrgId: org("GENERAL"), title: "Lab Technician", category: "ALLIED", specialty: "Pathology", location: "Vijayawada", minExperienceYears: 1, ctcMaxLakhs: 4, openings: 1 }),
  ];
  for (const v of vacs) {
    const matches = await matchesFor(v.id, 3);
    for (const m of matches) {
      if (!m.candidate.consentRecordStoreShare) continue;
      await submitCandidate(dixha, v.id, m.candidate.id, m.score);
      setClock(new Date(now().getTime() + 40 * 60_000));
    }
  }

  // Interviews → offer → joining for the first nurse vacancy
  const sanjay = await actor("sanjay");
  const subs = await prisma.submission.findMany({ where: { vacancyId: vacs[0].id }, orderBy: { submittedAt: "asc" } });
  if (subs[0]) {
    setClock(new Date(weekStart.getTime() - 4 * DAY + 5 * HOUR));
    const iv = await scheduleInterview(sanjay, subs[0].id, { scheduledAt: new Date(now().getTime() + DAY), mode: "IN_PERSON" });
    setClock(new Date(now().getTime() + DAY + 2 * HOUR));
    await recordInterviewOutcome(sanjay, iv.id, { status: "ATTENDED", result: "SELECTED" });
    const offer = await sendOffer(sanjay, subs[0].id, { ctcLakhs: 5.4 });
    await confirmJoiningDate(sanjay, offer.id, new Date(now().getTime() + DAY));
    setClock(new Date(now().getTime() + DAY));
    const j = await recordJoining(sanjay, offer.id, now());
    await completeFormalities(sanjay, j.id);
  }
  if (subs[1]) {
    setClock(new Date(realNow.getTime() - 2 * HOUR));
    await scheduleInterview(sanjay, subs[1].id, { scheduledAt: new Date(realNow.getTime() + 2 * DAY), mode: "VIDEO" });
  }

  // A scorecard comparison
  const tpl = await prisma.evalTemplate.findFirst();
  const cmp = await prisma.submission.findMany({ where: { vacancyId: vacs[0].id }, take: 3 });
  if (tpl && cmp.length >= 2) {
    const e = await createEvaluation(sanjay, { title: "ICU nurse shortlist", templateId: tpl.id, vacancyId: vacs[0].id, candidateIds: cmp.map((s) => s.candidateId) });
    const { leaves } = await templateLeaves(tpl.id);
    await saveScores(sanjay, e.id, cmp.flatMap((s, ci) => leaves.map((l, li) => ({ criterionId: l.id, candidateId: s.candidateId, score: 1 + ((li + ci * 2 + 2) % 5) }))));
  }

  // A red flag with CAPA
  const sumitha = await actor("sumitha");
  setClock(new Date(weekStart.getTime() - 3 * DAY + 5 * HOUR));
  const f = await raiseRedFlag(sumitha, { teamCode: "T1B", description: "Missed-call recalls not attempted within 2 hours", kpiDeviated: "MC: recalls / missed %", targetStandard: "≥ 95%", actual: "50%", agentId: (await prisma.user.findUniqueOrThrow({ where: { email: emailFor("bhavani") } })).id });
  await suggestCapa(sumitha, f.id, { capaSuggested: "Check missed-call inbox every hour; TL spot-checks at 12 pm and 4 pm", expectedOutcome: "≥ 95% recalls within 2 hours", dueDate: new Date(now().getTime() + DAY), actionOwnerId: (await prisma.user.findUniqueOrThrow({ where: { email: emailFor("sarala") } })).id });

  // Attendance for the last two weeks (Mon–Sat)
  const users = await prisma.user.findMany({ where: { email: { not: emailFor("admin") } } });
  for (let d = 0; d < 14; d++) {
    const day = new Date(t0.getTime() + d * DAY);
    const ist = new Date(day.getTime() + 330 * 60_000);
    if (ist.getUTCDay() === 0) continue;
    const date = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
    for (const u of users) await prisma.attendance.upsert({ where: { userId_date: { userId: u.id, date } }, create: { userId: u.id, date }, update: {} });
  }

  setClock(null);
  void SYSTEM;
}
