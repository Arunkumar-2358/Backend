import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { DEV_PASSWORD, emailFor } from "@/modules/seed/core";
import { resetDb } from "../helpers";
import { driveTo } from "../drive";
import { call } from "./client";

beforeEach(resetDb);

describe("HTTP: my profile", () => {
  it("returns the caller's profile, roles and stats without the password hash", async () => {
    await driveTo("VALIDATED"); // owned by jennifer
    const res = await call({ method: "GET", url: "/v1/me/profile", as: "jennifer" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe(emailFor("jennifer"));
    expect(body.user).not.toHaveProperty("passwordHash");
    expect(body.user.roles[0]).toMatchObject({ role: "ta_lead", category: "NURSE", team: { name: expect.any(String) } });
    expect(body.owned).toBe(1);
    expect(body.byStage).toEqual([{ stage: "VALIDATED", count: 1 }]);
    expect((await call({ method: "GET", url: "/v1/me/profile" })).statusCode).toBe(401);
  });

  it("updates name and phone, validating the mobile", async () => {
    expect((await call({ method: "PUT", url: "/v1/me/profile", as: "jennifer", payload: { name: "  " } })).json().error.message).toBe("Name is required");
    expect((await call({ method: "PUT", url: "/v1/me/profile", as: "jennifer", payload: { name: "Jen", phone: "123" } })).statusCode).toBe(422);
    const ok = await call({ method: "PUT", url: "/v1/me/profile", as: "jennifer", payload: { name: "Jennifer R", phone: "+91 98765 43210" } });
    expect(ok.json().message).toBe("Profile updated");
    const u = await prisma.user.findUniqueOrThrow({ where: { email: emailFor("jennifer") } });
    expect(u.name).toBe("Jennifer R");
    expect(u.phone).toBe("9876543210");
  });

  it("changes the password only with the current one and a strong new one", async () => {
    const put = (payload: object) => call({ method: "PUT", url: "/v1/me/password", as: "jennifer", payload });
    expect((await put({ current: "wrong", next: "abcd1234", confirm: "abcd1234" })).json().error.message).toBe("Current password is incorrect");
    expect((await put({ current: DEV_PASSWORD, next: "short", confirm: "short" })).statusCode).toBe(422);
    expect((await put({ current: DEV_PASSWORD, next: "abcd1234", confirm: "abcd12345" })).json().error.message).toBe("New passwords do not match");
    const ok = await put({ current: DEV_PASSWORD, next: "abcd1234", confirm: "abcd1234" });
    expect(ok.json().message).toBe("Password changed");
    const login = await call({ method: "POST", url: "/v1/auth/login", payload: { email: emailFor("jennifer"), password: "abcd1234" } });
    expect(login.statusCode).toBe(200);
  });

  it("saves the theme preference and rejects unknown themes", async () => {
    const ok = await call({ method: "PUT", url: "/v1/me/theme", as: "jennifer", payload: { theme: "dark" } });
    expect(ok.json()).toEqual({ message: "Theme saved", theme: "dark" });
    expect((await prisma.user.findUniqueOrThrow({ where: { email: emailFor("jennifer") } })).theme).toBe("dark");
    expect((await call({ method: "PUT", url: "/v1/me/theme", as: "jennifer", payload: { theme: "neon" } })).statusCode).toBe(422);
  });
});
