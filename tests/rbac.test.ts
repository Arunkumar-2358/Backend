import { describe, it, expect, beforeAll } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { leadScope, canManageRedFlags } from "@/lib/rbac";
import { signSession, verifySession } from "@/lib/session-token";
import { USERS, DEV_PASSWORD, emailFor } from "@/modules/seed/core";
import { resetDb, as } from "./helpers";
import { driveTo } from "./drive";

beforeAll(resetDb);

describe("roles, login and menus", () => {
  it("every seeded user can log in with the dev password", async () => {
    for (const u of USERS) {
      const row = await prisma.user.findUniqueOrThrow({ where: { email: emailFor(u.key) } });
      expect(await bcrypt.compare(DEV_PASSWORD, row.passwordHash)).toBe(true);
    }
  });

  it("session tokens round-trip and reject tampering", async () => {
    const t = await signSession({ sub: "u1", name: "X", roles: ["ta_lead"] });
    expect((await verifySession(t))?.roles).toEqual(["ta_lead"]);
    expect(await verifySession(t.slice(0, -2) + "xx")).toBeNull();
  });

  it("agents only see their own leads; leaders see their stages; coordinator sees all", async () => {
    const nurse = await driveTo("VALIDATED", { mainCategory: "NURSE" });
    const pharm = await driveTo("VALIDATED", { mainCategory: "PHARMACY", primarySpecialty: "Retail" });
    const count = async (key: string) => prisma.candidate.count({ where: { AND: [leadScope(await as(key)), { id: { in: [nurse.id, pharm.id] } }] } });
    expect(await count("jennifer")).toBe(1);
    expect(await count("poojitha")).toBe(1);
    expect(await count("sarala")).toBe(2);
    expect(await count("harsha")).toBe(0);
    expect(await count("sumitha")).toBe(2);
    expect(canManageRedFlags(await as("sumitha"))).toBe(true);
    expect(canManageRedFlags(await as("sarala"))).toBe(false);
  });
});
