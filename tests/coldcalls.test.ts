import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { now, advanceClock, setClock, DAY, HOUR } from "@/lib/clock";
import { setSetting } from "@/lib/settings";
import { recordPlatformVisits } from "@/modules/engagement/service";
import { allocateColdCalls, logColdCall } from "@/modules/coldcalls/service";
import { getColdCalls } from "@/modules/coldcalls/queries";
import { decryptCandidate } from "@/modules/candidates/service";
import { engagementTier } from "@contracts/shared/engagement";
import type { UserActor } from "@/platform/endpoint";
import { resetDb, as, userId } from "./helpers";
import { driveTo } from "./drive";

beforeEach(async () => {
  await resetDb();
  setClock(new Date("2026-06-01T05:00:00Z"));
});

const user = async (key: string) => (await as(key)) as UserActor;
const lead = (id: string) => prisma.candidate.findUniqueOrThrow({ where: { id } });
const openTask = (candidateId: string) => prisma.task.findFirst({ where: { candidateId, type: "COLD_CALL", status: "OPEN" } });

/** Three nurse leads (owned by Sri Vidya) that are cold 61 days later. */
async function coldLeads(n = 3) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push((await driveTo("ACTIVE")).id);
  advanceClock(61 * DAY);
  return ids;
}

describe("allocating cold leads for calls", () => {
  it("only the Team 2 leader allocates, only to Team 2, and only cold leads", async () => {
    const [a] = await coldLeads(1);
    const warm = await driveTo("ACTIVE"); // engaged just now
    const sv = await userId("srividya");
    await expect(allocateColdCalls(await as("srividya"), { callerId: sv, ids: [a] })).rejects.toThrow(/Team 2 leader/);
    await expect(allocateColdCalls(await as("sanjay"), { callerId: sv, ids: [a] })).rejects.toThrow(/Team 2 leader/);
    await expect(allocateColdCalls(await as("dixha"), { callerId: await userId("harsha"), ids: [a] })).rejects.toThrow(/Team 2 member/);
    await expect(allocateColdCalls(await as("dixha"), { callerId: sv, ids: [warm.id] })).rejects.toThrow(/No cold leads/);

    const { count } = await allocateColdCalls(await as("dixha"), { callerId: await userId("amos"), ids: [a] });
    expect(count).toBe(1);
    const task = await openTask(a);
    expect(task).toMatchObject({ assigneeId: await userId("amos"), title: "Cold lead call: ask if they need a job" });
    expect(await prisma.notification.count({ where: { userId: await userId("amos"), link: "/cold-calls" } })).toBe(1);
    // Once allocated it leaves the pool for this cold spell.
    await expect(allocateColdCalls(await as("dixha"), { callerId: sv, ids: [a] })).rejects.toThrow(/No cold leads/);
  });

  it("allocates the next N of a category, and a lead that re-engages then goes cold again can be allocated again", async () => {
    const ids = await coldLeads(3);
    const view = await getColdCalls(await user("dixha"), {});
    expect(view.pool).toMatchObject({ total: 3, categories: [{ category: "NURSE", waiting: 3, suggestedCallerId: await userId("srividya") }] });
    expect((await getColdCalls(await user("srividya"), {})).pool).toBeNull();

    expect((await allocateColdCalls(await as("dixha"), { callerId: await userId("srividya"), category: "NURSE", count: 2 })).count).toBe(2);
    expect((await getColdCalls(await user("dixha"), {})).pool!.total).toBe(1);

    // Every lead is allocated; one visits the platform (a new spell) and goes cold again 61 days later.
    await allocateColdCalls(await as("dixha"), { callerId: await userId("srividya"), category: "NURSE" });
    const back = ids[0];
    await prisma.task.updateMany({ where: { candidateId: back, type: "COLD_CALL" }, data: { status: "DONE" } });
    advanceClock(HOUR);
    await recordPlatformVisits([{ mobile: decryptCandidate(await lead(back)).mobile! }]);
    expect((await getColdCalls(await user("dixha"), {})).pool!.total).toBe(0); // engaged: not cold
    advanceClock(61 * DAY);
    expect((await getColdCalls(await user("dixha"), {})).pool!.leads.map((l) => l.id)).toEqual([back]);
  });
});

describe("logging cold-lead calls", () => {
  it("no answer comes back as a recall until the attempt cap; needs a job → super active", async () => {
    const [a, b] = await coldLeads(2);
    const sv = await as("srividya");
    await allocateColdCalls(await as("dixha"), { callerId: await userId("srividya"), ids: [a, b] });

    const r1 = await logColdCall(sv, a, { outcome: "UNANSWERED" });
    expect(r1).toEqual({ outcome: "UNANSWERED", closed: false, attempts: 1 });
    const task = (await openTask(a))!;
    expect(task.title).toBe("Cold lead recall (attempt 2 of 3)");
    expect(task.dueAt).toEqual(new Date(now().getTime() + 24 * HOUR));
    const [first] = await prisma.contactAttempt.findMany({ where: { candidateId: a, coldCall: true } });
    expect(first).toMatchObject({ direction: "OUTBOUND", outcome: "UNANSWERED", channel: "CALL" });

    advanceClock(24 * HOUR);
    await logColdCall(sv, a, { outcome: "UNANSWERED" });
    advanceClock(24 * HOUR);
    const r3 = await logColdCall(sv, a, { outcome: "UNANSWERED" });
    expect(r3).toEqual({ outcome: "UNANSWERED", closed: true, attempts: 3 });
    expect(await openTask(a)).toBeNull();
    expect(await prisma.contactAttempt.count({ where: { candidateId: a, coldCall: true, direction: "RECALL" } })).toBe(2);
    // Team 1's attempt counter (the Unreachable cap) is untouched.
    expect((await lead(a)).contactAttemptCount).toBe(1);

    await logColdCall(sv, b, { outcome: "NEEDS_JOB", notes: "Wants ICU roles in Hyderabad" });
    const lb = await lead(b);
    expect(lb.jobIntentAt).toEqual(now());
    expect(engagementTier(lb.lastEngagedAt, now())).toBe("SUPER_ACTIVE");
    expect(await openTask(b)).toBeNull();
    await expect(logColdCall(sv, b, { outcome: "UNANSWERED" })).rejects.toThrow(/No cold-lead call/);
  });

  it("only the assignee (or the Team 2 leader) can log the call; settings change the cap and recall delay", async () => {
    await setSetting("coldCallMaxAttempts", 1);
    const [a, b] = await coldLeads(2);
    await allocateColdCalls(await as("dixha"), { callerId: await userId("srividya"), ids: [a, b] });
    await expect(logColdCall(await as("amos"), a, { outcome: "NEEDS_JOB" })).rejects.toThrow(/someone else/);
    expect(await logColdCall(await as("srividya"), a, { outcome: "UNANSWERED" })).toMatchObject({ closed: true, attempts: 1 });
    expect(await logColdCall(await as("dixha"), b, { outcome: "NOT_INTERESTED" })).toMatchObject({ closed: true });
  });

  it("the queue lists the caller's calls with the attempt number and today's counts", async () => {
    const [a, b] = await coldLeads(2);
    await allocateColdCalls(await as("dixha"), { callerId: await userId("srividya"), ids: [a] });
    await allocateColdCalls(await as("dixha"), { callerId: await userId("amos"), ids: [b] });
    await logColdCall(await as("srividya"), a, { outcome: "UNANSWERED" });

    const mine = await getColdCalls(await user("srividya"), {});
    expect(mine).toMatchObject({ scope: "mine", total: 1, maxAttempts: 3, today: { allocated: 1, calls: 1, answered: 0, superActive: 0 } });
    expect(mine.rows[0]).toMatchObject({ attempt: 2, candidate: { id: a, tier: "COLD" }, lastCall: { outcome: "UNANSWERED" } });
    // A sourcer cannot widen to the team; the leader can.
    expect((await getColdCalls(await user("srividya"), { scope: "team" })).scope).toBe("mine");
    expect((await getColdCalls(await user("dixha"), { scope: "team" })).total).toBe(2);
  });
});
