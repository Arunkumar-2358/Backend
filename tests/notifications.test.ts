import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { setClock } from "@/lib/clock";
import { logContact } from "@/modules/outreach/service";
import { raiseRedFlag, suggestCapa } from "@/modules/redflags/service";
import { runImport, autoMap } from "@/modules/import/pipeline";
import { markAllRead, unreadCount } from "@/modules/notifications/service";
import { resetDb, as, userId } from "./helpers";
import { driveTo } from "./drive";

beforeEach(async () => {
  await resetDb();
  setClock("2026-09-21T04:30:00Z");
});

const inbox = async (key: string) => prisma.notification.findMany({ where: { userId: await userId(key) }, orderBy: { createdAt: "asc" } });

describe("notifications", () => {
  it("tells the Team 2 sourcer when a lead is enrolled into their queue", async () => {
    const { id } = await driveTo("VALIDATED");
    await logContact(await as("jennifer"), id, { channel: "CALL", outcome: "ENROLLED" });
    const n = await inbox("srividya");
    expect(n.map((x) => x.kind)).toEqual(["LEAD_ASSIGNED"]);
    expect(n[0].link).toBe(`/leads/${id}`);
  });

  it("notifies the assignee of a follow-up, but not the person who created it", async () => {
    const { id } = await driveTo("VALIDATED");
    const before = (await inbox("jennifer")).length;
    await logContact(await as("jennifer"), id, { channel: "CALL", outcome: "BUSY_RECALL_REQUESTED" });
    expect((await inbox("jennifer")).length).toBe(before + 1); // created by the follow-up engine (system) for Jennifer
    expect((await inbox("jennifer")).at(-1)!.kind).toBe("TASK");
  });

  it("sends one import summary instead of a notification per lead", async () => {
    const rows = [1, 2, 3].map((i) => ({ Name: `N${i}`, Mobile: `900000000${i}`, Category: "Nurse", "Job Title": "Staff Nurse", Location: "Hyderabad" }));
    await runImport(await as("greeshma"), { fileName: "x.csv", rows, mapping: autoMap(Object.keys(rows[0])), source: "OTHER" });
    const j = await inbox("jennifer");
    expect(j).toHaveLength(1);
    expect(j[0].title).toBe("3 new validated leads in your queue");
    expect((await inbox("greeshma")).map((x) => x.kind)).toEqual(["IMPORT"]);
  });

  it("red flags reach the agent and team leader; CAPA reaches the action owner", async () => {
    const f = await raiseRedFlag(await as("sumitha"), { teamCode: "T1A", description: "Low enrolment", agentId: await userId("jennifer") });
    expect((await inbox("jennifer")).map((x) => x.kind)).toEqual(["RED_FLAG"]);
    expect((await inbox("sarala")).map((x) => x.kind)).toEqual(["RED_FLAG"]);
    expect(await inbox("sumitha")).toHaveLength(0);
    await suggestCapa(await as("sumitha"), f.id, { capaSuggested: "Retrain", actionOwnerId: await userId("sarala") });
    expect((await inbox("sarala")).map((x) => x.kind)).toEqual(["RED_FLAG", "CAPA"]);
    await markAllRead(await userId("sarala"));
    expect(await unreadCount(await userId("sarala"))).toBe(0);
  });
});
