import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { now, advanceClock, setClock, DAY } from "@/lib/clock";
import { leadScope } from "@/lib/rbac";
import { setSetting } from "@/lib/settings";
import { transitionLead } from "@/modules/lifecycle/transition";
import { recordAvailabilityCheck } from "@/modules/scrutiny/service";
import { getAvailability } from "@/modules/scrutiny/queries";
import { allocateQualified } from "@/modules/allocation/service";
import { getAllocation } from "@/modules/allocation/queries";
import { handleInboundWhatsApp, markJobIntent, queueColdReengagements, recordPlatformVisits } from "@/modules/engagement/service";
import { getEngagement } from "@/modules/engagement/queries";
import { runDueJobs } from "@/modules/jobs/runner";
import { decryptCandidate } from "@/modules/candidates/service";
import { engagementTier, readJobIntent } from "@contracts/shared/engagement";
import type { UserActor } from "@/platform/endpoint";
import { resetDb, as, userId, memory } from "./helpers";
import { driveTo, ownerActor } from "./drive";

beforeEach(async () => {
  await resetDb();
  setClock(new Date("2026-09-01T05:00:00Z"));
});

const user = async (key: string) => (await as(key)) as UserActor;
const lead = (id: string) => prisma.candidate.findUniqueOrThrow({ where: { id } });
const mobileOf = async (id: string) => decryptCandidate(await lead(id)).mobile!;
const visibleTo = async (key: string, id: string) => (await prisma.candidate.count({ where: { AND: [{ id }, leadScope(await as(key))] } })) > 0;

describe("Qualified → Team 3 leader → Team 2 allocation", () => {
  it("a qualified lead waits in the Team 3 pool, visible to Team 3, until allocated", async () => {
    const { id } = await driveTo("QUALIFIED", {}, { allocate: false });
    const c = await lead(id);
    expect(c.allocatedAt).toBeNull();
    expect(await visibleTo("sanjay", id)).toBe(true);
    // A regular recruiter has no ownership or task on it yet — only the Team 3 leader can open it.
    expect(await visibleTo("harsha", id)).toBe(false);
    // No Team 2 check-in until allocation; Active is gated on it.
    expect(await prisma.task.count({ where: { candidateId: id, type: "AVAILABILITY_CHECK", status: "OPEN" } })).toBe(0);
    await expect(recordAvailabilityCheck(await ownerActor(id), id, true, undefined)).rejects.toThrow(/Team 3 leader/);
    await expect(transitionLead(await as("admin"), id, "ACTIVE")).rejects.toThrow(/allocated/);
    expect((await getAvailability(await user("dixha"), {})).awaitingAllocation).toBe(1);
    // The Team 3 leader is told.
    const sanjay = await userId("sanjay");
    expect(await prisma.notification.count({ where: { userId: sanjay, link: "/allocation" } })).toBe(1);
  });

  it("only the Team 3 leader (or admin) allocates, and only to Team 2", async () => {
    const { id } = await driveTo("QUALIFIED", {}, { allocate: false });
    const amos = await userId("amos");
    await expect(allocateQualified(await as("dixha"), { sourcerId: amos, ids: [id] })).rejects.toThrow(/Team 3 leader/);
    await expect(allocateQualified(await as("harsha"), { sourcerId: amos, ids: [id] })).rejects.toThrow(/Team 3 leader/);
    await expect(allocateQualified(await as("sanjay"), { sourcerId: await userId("harsha"), ids: [id] })).rejects.toThrow(/Team 2/);
  });

  it("allocating a category hands those leads to the sourcer and starts their check-ins", async () => {
    const doc1 = await driveTo("QUALIFIED", { mainCategory: "DOCTOR", jobTitle: "Consultant" }, { allocate: false });
    const doc2 = await driveTo("QUALIFIED", { mainCategory: "DOCTOR", jobTitle: "Consultant" }, { allocate: false });
    const pharm = await driveTo("QUALIFIED", { mainCategory: "PHARMACY", jobTitle: "Pharmacist" }, { allocate: false });
    const bhavya = await userId("bhavya");

    const view = await getAllocation(await user("sanjay"), {});
    expect(view.canAllocate).toBe(true);
    expect(view.categories.find((c) => c.category === "DOCTOR")).toMatchObject({ pending: 2, suggestedSourcerId: bhavya });
    expect(view.categories.find((c) => c.category === "PHARMACY")?.pending).toBe(1);
    expect((await getAllocation(await user("harsha"), {})).canAllocate).toBe(false);

    const { count } = await allocateQualified(await as("sanjay"), { sourcerId: bhavya, category: "DOCTOR" });
    expect(count).toBe(2);
    for (const { id } of [doc1, doc2]) {
      const c = await lead(id);
      expect(c.ownerUserId).toBe(bhavya);
      expect(c.allocatedById).toBe(await userId("sanjay"));
      expect(await prisma.task.count({ where: { candidateId: id, type: "AVAILABILITY_CHECK", assigneeId: bhavya, status: "OPEN" } })).toBe(1);
      expect(await prisma.scheduledJob.count({ where: { dedupeKey: `avail:${id}`, status: "PENDING" } })).toBe(1);
    }
    expect((await lead(pharm.id)).allocatedAt).toBeNull();
    // One summary notification, and the sourcer's lists now hold exactly their category.
    expect(await prisma.notification.count({ where: { userId: bhavya, title: "2 qualified leads allocated to you" } })).toBe(1);
    const mine = await getEngagement(await user("bhavya"), {});
    expect(mine.scope).toBe("mine");
    expect(mine.rows.map((r) => r.id).sort()).toEqual([doc1.id, doc2.id].sort());
    // Nothing is left to allocate in that category.
    await expect(allocateQualified(await as("sanjay"), { sourcerId: bhavya, category: "DOCTOR" })).rejects.toThrow(/No qualified leads/);

    // Allocated → Team 2 can confirm availability → Active.
    await recordAvailabilityCheck(await as("bhavya"), doc1.id, true, undefined);
    expect((await lead(doc1.id)).stage).toBe("ACTIVE");
  });
});

describe("engagement tiers", () => {
  it("classifies by days since last engaged (5 / 14 / 60 by default)", () => {
    const at = new Date("2026-09-30T00:00:00Z");
    const ago = (d: number) => new Date(at.getTime() - d * DAY);
    expect(engagementTier(ago(0), at)).toBe("SUPER_ACTIVE");
    expect(engagementTier(ago(5), at)).toBe("SUPER_ACTIVE");
    expect(engagementTier(ago(6), at)).toBe("ACTIVE");
    expect(engagementTier(ago(14), at)).toBe("ACTIVE");
    expect(engagementTier(ago(15), at)).toBe("WARM");
    expect(engagementTier(ago(60), at)).toBe("WARM");
    expect(engagementTier(ago(61), at)).toBe("COLD");
    expect(engagementTier(null, at)).toBe("COLD");
  });

  it("enrolment starts the clock; platform visits move it forward, never back", async () => {
    const { id } = await driveTo("ACTIVE");
    const enrolled = (await lead(id)).lastEngagedAt!;
    expect(enrolled).toEqual((await lead(id)).enrolledAt);

    advanceClock(20 * DAY);
    let v = await getEngagement(await user("dixha"), {});
    expect(v.rows.find((r) => r.id === id)?.tier).toBe("WARM");

    expect(await recordPlatformVisits([{ mobile: await mobileOf(id) }, { mobile: "9999999999" }])).toEqual({ matched: 1, unknown: 1 });
    v = await getEngagement(await user("dixha"), { tier: "SUPER_ACTIVE" });
    expect(v.rows.map((r) => r.id)).toEqual([id]);
    expect(v.counts).toEqual({ SUPER_ACTIVE: 1, ACTIVE: 0, WARM: 0, COLD: 0 });

    // An older visit reported late does not move the lead back.
    const latest = (await lead(id)).lastEngagedAt!;
    await recordPlatformVisits([{ mobile: await mobileOf(id), visitedAt: new Date(now().getTime() - 30 * DAY).toISOString() }]);
    expect((await lead(id)).lastEngagedAt).toEqual(latest);
  });

  it("uses the admin's tier thresholds", async () => {
    const { id } = await driveTo("ACTIVE");
    advanceClock(8 * DAY);
    expect((await getEngagement(await user("dixha"), {})).rows.find((r) => r.id === id)?.tier).toBe("ACTIVE");
    await setSetting("engagementTierDays", { superActive: 10, active: 20, warm: 30 });
    expect((await getEngagement(await user("dixha"), {})).rows.find((r) => r.id === id)?.tier).toBe("SUPER_ACTIVE");
  });
});

describe("cold leads: re-engagement WhatsApp and replies", () => {
  async function coldLead() {
    const { id } = await driveTo("ACTIVE");
    advanceClock(61 * DAY);
    return id;
  }
  const reengagements = () => memory.sent.filter((m) => m.body.includes("since you visited Nextenti"));

  it("messages a lead once when it goes cold (> 60 days), not again while it stays cold", async () => {
    const id = await coldLead();
    const warm = await driveTo("ACTIVE"); // engaged just now
    expect(await queueColdReengagements()).toBe("1 re-engagement message(s) queued");
    await runDueJobs();
    expect(reengagements()).toHaveLength(1);
    expect((await lead(id)).reengageSentAt).not.toBeNull();
    expect((await lead(warm.id)).reengageSentAt).toBeNull();

    advanceClock(DAY);
    expect(await queueColdReengagements()).toBe("0 re-engagement message(s) queued");
    expect((await getEngagement(await user("dixha"), {})).awaitingReply).toBe(1);
  });

  it("a reply saying they need a job makes the lead super active immediately", async () => {
    const id = await coldLead();
    await queueColdReengagements();
    await runDueJobs();
    const owner = (await lead(id)).ownerUserId!;

    const r = await handleInboundWhatsApp([{ providerRef: "wamid.1", from: `91${await mobileOf(id)}`, text: "Yes, I need a job" }]);
    expect(r).toMatchObject({ stored: 1, looking: 1 });
    const c = await lead(id);
    expect(c.jobIntentAt).toEqual(now());
    expect(engagementTier(c.lastEngagedAt, now())).toBe("SUPER_ACTIVE");
    expect(await prisma.notification.count({ where: { userId: owner, title: { contains: "now Super active" } } })).toBe(1);

    // Provider retries of the same message are ignored.
    expect(await handleInboundWhatsApp([{ providerRef: "wamid.1", from: `91${await mobileOf(id)}`, text: "Yes, I need a job" }])).toMatchObject({ duplicates: 1, stored: 0 });
  });

  it("'no' is recorded and the lead stays cold; an unclear reply opens a review task", async () => {
    const no = await coldLead();
    const unclear = await driveTo("ACTIVE");
    await prisma.candidate.update({ where: { id: unclear.id }, data: { lastEngagedAt: new Date(now().getTime() - 70 * DAY) } });
    await queueColdReengagements();
    await runDueJobs();

    await handleInboundWhatsApp([
      { providerRef: "wamid.no", from: await mobileOf(no), text: "No thanks" },
      { providerRef: "wamid.q", from: await mobileOf(unclear.id), text: "Which hospital is this for?" },
    ]);
    expect(engagementTier((await lead(no)).lastEngagedAt, now())).toBe("COLD");
    expect(await prisma.inboundMessage.findUniqueOrThrow({ where: { providerRef: "wamid.no" } })).toMatchObject({ intent: "NOT_LOOKING", candidateId: no });
    const task = await prisma.task.findFirstOrThrow({ where: { candidateId: unclear.id, type: "REENGAGE_REPLY", status: "OPEN" } });
    expect(task.assigneeId).toBe((await lead(unclear.id)).ownerUserId);

    // The owner reads it, calls, and confirms the job need by hand → super active, task closed.
    await markJobIntent(await ownerActor(unclear.id), unclear.id, "Called back — looking for ICU roles");
    expect(engagementTier((await lead(unclear.id)).lastEngagedAt, now())).toBe("SUPER_ACTIVE");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("DONE");
  });

  it("a 'yes' that is not a reply to the re-engagement message changes nothing", async () => {
    const { id } = await driveTo("ACTIVE");
    await handleInboundWhatsApp([{ providerRef: "wamid.x", from: await mobileOf(id), text: "YES" }]);
    expect((await prisma.inboundMessage.findUniqueOrThrow({ where: { providerRef: "wamid.x" } })).intent).toBe("UNCLEAR");
    expect((await lead(id)).jobIntentAt).toBeNull();
  });

  it("goes cold again after a visit → a new message; the daily cap limits a backlog", async () => {
    const id = await coldLead();
    await queueColdReengagements();
    await runDueJobs();
    advanceClock(DAY);
    await recordPlatformVisits([{ mobile: await mobileOf(id) }]);
    advanceClock(61 * DAY);
    await queueColdReengagements();
    await runDueJobs();
    expect(reengagements()).toHaveLength(2);

    await driveTo("ACTIVE");
    await driveTo("ACTIVE");
    advanceClock(61 * DAY);
    await setSetting("reengageDailyLimit", 1);
    expect(await queueColdReengagements()).toBe("1 re-engagement message(s) queued");
  });

  it("only the owner or Team 2 leader can confirm a job need", async () => {
    const { id } = await driveTo("ACTIVE");
    await expect(markJobIntent(await as("amos"), id, undefined)).rejects.toThrow(/Team 2/);
    await markJobIntent(await as("dixha"), id, undefined);
  });

  it("reads yes / no replies and button ids", () => {
    expect(readJobIntent("JOB_YES")).toBe("LOOKING");
    expect(readJobIntent("yes please")).toBe("LOOKING");
    expect(readJobIntent("Haan")).toBe("LOOKING");
    expect(readJobIntent("JOB_NO")).toBe("NOT_LOOKING");
    expect(readJobIntent("not looking right now")).toBe("NOT_LOOKING");
    expect(readJobIntent("no")).toBe("NOT_LOOKING");
    expect(readJobIntent("yesterday I called")).toBe("UNCLEAR");
    expect(readJobIntent("what is the salary?")).toBe("UNCLEAR");
  });
});
