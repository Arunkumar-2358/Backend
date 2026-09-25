import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/db";
import { getAllSettings } from "@/lib/settings";
import { periodRange } from "@contracts/shared/dates";
import { KPI_BY_KEY } from "@/kpi/definitions";
import { resetDb, userId } from "./helpers";

beforeAll(resetDb);

describe("working days at IST week boundaries", () => {
  it("counts Mon–Sun of the IST week and excludes the Sundays either side", async () => {
    const id = await userId("jennifer");
    for (const d of [20, 21, 27, 28]) await prisma.attendance.create({ data: { userId: id, date: new Date(Date.UTC(2026, 8, d)) } });
    const { start, end } = periodRange("WEEK", new Date("2026-09-23T06:00:00Z"));
    const v = await KPI_BY_KEY["t1a.working_days"].compute!({ db: prisma, start, end, userIds: [id], team: "T1A", settings: await getAllSettings() });
    expect(v).toBe(2); // Mon 21 and Sun 27
  });
});
