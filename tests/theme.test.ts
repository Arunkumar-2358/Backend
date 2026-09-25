import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/db";
import { parseThemePref } from "@/lib/theme";
import { setThemePreference } from "@/modules/users/preferences";
import { resetDb, as, userId } from "./helpers";

beforeAll(resetDb);

describe("theme preference", () => {
  it("defaults to system and saves per user with an audit entry", async () => {
    const id = await userId("jennifer");
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).theme).toBe("system");
    const actor = await as("jennifer");
    if (actor.kind !== "user") throw new Error();
    await setThemePreference(actor, "dark");
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).theme).toBe("dark");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: await userId("bhavani") } })).theme).toBe("system");
    expect(await prisma.auditLog.count({ where: { entityId: id, action: "SETTING_CHANGE" } })).toBe(1);
    await expect(setThemePreference(actor, "purple")).rejects.toThrow(/Unknown theme/);
  });
  it("parses unknown cookie values as system", () => {
    expect(parseThemePref("dark")).toBe("dark");
    expect(parseThemePref(undefined)).toBe("system");
    expect(parseThemePref("x")).toBe("system");
  });
});
