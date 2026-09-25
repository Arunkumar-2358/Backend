import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { setClock, advanceClock, MINUTE } from "@/lib/clock";
import { matchesFor, submitCandidate, sourcingStats } from "@/modules/vacancies/service";
import { runDueJobs } from "@/modules/jobs/runner";
import { scheduleJob } from "@/modules/jobs/queue";
import { resetDb, as, userId } from "./helpers";
import { driveTo, makeVacancy } from "./drive";

beforeEach(async () => {
  await resetDb();
  setClock("2026-09-21T04:30:00Z"); // 10:00 IST
});

describe("vacancies (M4)", () => {
  it("routes to 3a / 3b / 3c by client org type and records the 2 pm cut-off", async () => {
    const a = await makeVacancy({}, "GENERAL");
    const b = await makeVacancy({}, "EXISTING");
    setClock("2026-09-21T09:00:00Z"); // 14:30 IST
    const c = await makeVacancy({}, "FREE_TRIAL");
    expect([a.routedTeam, b.routedTeam, c.routedTeam]).toEqual(["T3A", "T3B", "T3C"]);
    expect(a.recruiterId).toBe(await userId("harsha"));
    expect(b.recruiterId).toBe(await userId("sampath"));
    expect(a.sourcerId).toBe(await userId("srividya"));
    expect(a.addedBefore2pm).toBe(true);
    expect(c.addedBefore2pm).toBe(false);
  });

  it("ranks Active leads by match score (category is a hard filter)", async () => {
    const best = await driveTo("ACTIVE", { name: "Best", primarySpecialty: "ICU", experienceYears: 5, preferredLocations: ["Hyderabad"], expectedCtcLakhs: 4, noticePeriodDays: 15 });
    const mid = await driveTo("ACTIVE", { name: "Mid", primarySpecialty: "OT", secondarySkills: ["ICU"], experienceYears: 1, preferredLocations: ["Pune", "Hyderabad"], expectedCtcLakhs: 5.5, noticePeriodDays: 60 });
    await driveTo("ACTIVE", { name: "Pharm", mainCategory: "PHARMACY", primarySpecialty: "ICU" });
    await driveTo("QUALIFIED", { name: "NotActive", primarySpecialty: "ICU" });
    const v = await makeVacancy();
    const m = await matchesFor(v.id);
    expect(m.map((x) => x.candidate.name)).toEqual(["Best", "Mid"]);
    expect(m[0].score).toBe(100);
    expect(m[1].breakdown).toEqual({ specialty: 15, experience: 8, location: 16, ctc: 10, notice: 5 });
    void best; void mid;
  });

  it("computes the 5-CV target, NT vs non-NT and TAT in minutes", async () => {
    const v = await makeVacancy();
    const leads = [];
    for (let i = 0; i < 5; i++) leads.push(await driveTo("ACTIVE", { source: i < 3 ? "NT" : "NAUKRI" }));
    setClock("2026-09-21T04:30:00Z");
    await prisma.vacancy.update({ where: { id: v.id }, data: { postedAt: new Date("2026-09-21T04:30:00Z"), calibratedAt: null } });
    advanceClock(20 * MINUTE);
    for (const l of leads) {
      advanceClock(10 * MINUTE);
      await submitCandidate(await as("srividya"), v.id, l.id);
    }
    const full = await prisma.vacancy.findUniqueOrThrow({ where: { id: v.id }, include: { submissions: true } });
    const s = sourcingStats(full, 5);
    expect(s).toMatchObject({ submissions: 5, nt: 3, nonNt: 2, targetMet: true, tatMinutes: 70, postToCalibrationMinutes: 30, calibrationToTargetMinutes: 40 });
    expect(full.sourcingCompletedAt).not.toBeNull();
  });

  it("the nightly job marks under-sourced vacancies from earlier days as pending", async () => {
    const v = await makeVacancy();
    setClock("2026-09-22T18:00:00Z");
    await scheduleJob("mark_pending_vacancies", new Date("2026-09-22T17:00:00Z"), {}, "mark_pending_vacancies");
    await runDueJobs();
    const u = await prisma.vacancy.findUniqueOrThrow({ where: { id: v.id } });
    expect(u.status).toBe("PENDING");
    expect(u.wasPending).toBe(true);
  });

  it("cannot submit a non-Active lead or twice", async () => {
    const v = await makeVacancy();
    const q = await driveTo("QUALIFIED");
    await expect(submitCandidate(await as("dixha"), v.id, q.id)).rejects.toThrow(/Active/);
    const a = await driveTo("ACTIVE");
    await submitCandidate(await as("dixha"), v.id, a.id);
    await expect(submitCandidate(await as("dixha"), v.id, a.id)).rejects.toThrow(/Only Active|Already/);
  });
});
