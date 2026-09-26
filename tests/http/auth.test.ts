import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { setClock } from "@/lib/clock";
import { DEV_PASSWORD, emailFor } from "@/modules/seed/core";
import { REFRESH_REUSE_GRACE_MS } from "@/modules/auth/sessions";
import { resetDb } from "../helpers";
import { call } from "./client";

beforeAll(resetDb);

describe("HTTP: auth", () => {
  it("logs in with valid credentials and returns a usable token", async () => {
    const res = await call({ method: "POST", url: "/v1/auth/login", payload: { email: emailFor("jennifer"), password: DEV_PASSWORD } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe(emailFor("jennifer"));
    expect(body.expiresIn).toBe(900);
    expect(body.refreshToken).toMatch(/^\w+\.[\w-]{40,}$/);
    const shell = await call({ method: "GET", url: "/v1/me/shell", headers: { authorization: `Bearer ${body.token}` } });
    expect(shell.statusCode).toBe(200);
    expect(shell.json().user.name).toBe(body.user.name);
  });

  it("rejects a wrong password with 401 and a structured error", async () => {
    const res = await call({ method: "POST", url: "/v1/auth/login", payload: { email: emailFor("jennifer"), password: "nope" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("rejects a malformed body with 422", async () => {
    const res = await call({ method: "POST", url: "/v1/auth/login", payload: { email: "not-an-email" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("requires a session for protected routes, via bearer or cookie", async () => {
    expect((await call({ method: "GET", url: "/v1/me/shell" })).statusCode).toBe(401);
    expect((await call({ method: "GET", url: "/v1/me/shell", headers: { authorization: "Bearer garbage" } })).statusCode).toBe(401);
    const login = await call({ method: "POST", url: "/v1/auth/login", payload: { email: emailFor("admin"), password: DEV_PASSWORD } });
    const viaCookie = await call({ method: "GET", url: "/v1/me/shell", cookies: { nt_session: login.json().token } });
    expect(viaCookie.statusCode).toBe(200);
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await call({ method: "GET", url: "/v1/nope", as: "admin" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

const loginAs = async (key: string) => (await call({ method: "POST", url: "/v1/auth/login", payload: { email: emailFor(key), password: DEV_PASSWORD } })).json();
const refreshWith = (refreshToken: string) => call({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken } });
const shellWith = (token: string) => call({ method: "GET", url: "/v1/me/shell", headers: { authorization: `Bearer ${token}` } });

describe("HTTP: refresh tokens", () => {
  afterEach(() => setClock(null));

  it("rotates: each refresh returns a new pair and the new access token works", async () => {
    const first = await loginAs("jennifer");
    const res = await refreshWith(first.refreshToken);
    expect(res.statusCode).toBe(200);
    const next = res.json();
    expect(next.refreshToken).not.toBe(first.refreshToken);
    expect((await shellWith(next.token)).statusCode).toBe(200);
  });

  it("treats reuse of a rotated token as theft and signs the whole session out", async () => {
    const first = await loginAs("jennifer");
    const second = (await refreshWith(first.refreshToken)).json();
    setClock(new Date(Date.now() + REFRESH_REUSE_GRACE_MS + 1000));
    expect((await refreshWith(first.refreshToken)).statusCode).toBe(401);
    // The attacker's replay also kills the legitimate chain and its access token.
    expect((await refreshWith(second.refreshToken)).statusCode).toBe(401);
    expect((await shellWith(second.token)).statusCode).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: "REFRESH_REUSE" } })).toBeGreaterThan(0);
  });

  it("tolerates a concurrent refresh inside the grace window (several tabs)", async () => {
    const first = await loginAs("jennifer");
    const [a, b] = await Promise.all([refreshWith(first.refreshToken), refreshWith(first.refreshToken)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
  });

  it("rejects unknown, tampered and expired refresh tokens", async () => {
    const first = await loginAs("jennifer");
    expect((await refreshWith("nope.nope-nope-nope")).statusCode).toBe(401);
    expect((await refreshWith(first.refreshToken.slice(0, -2) + "xx")).statusCode).toBe(401);
    setClock(new Date(Date.now() + 8 * 86_400_000));
    expect((await refreshWith(first.refreshToken)).statusCode).toBe(401);
  });

  it("logout revokes the session: its access and refresh tokens stop working", async () => {
    const s = await loginAs("jennifer");
    const out = await call({ method: "POST", url: "/v1/auth/logout", payload: { refreshToken: s.refreshToken } });
    expect(out.statusCode).toBe(200);
    expect((await shellWith(s.token)).statusCode).toBe(401);
    expect((await refreshWith(s.refreshToken)).statusCode).toBe(401);
  });

  it("logout-all signs out other devices and can keep the current one", async () => {
    const laptop = await loginAs("sarala");
    const phone = await loginAs("sarala");
    const res = await call({ method: "POST", url: "/v1/auth/logout-all", payload: { keepCurrent: true }, headers: { authorization: `Bearer ${laptop.token}` } });
    expect(res.json().revoked).toBeGreaterThan(0);
    expect((await shellWith(laptop.token)).statusCode).toBe(200);
    expect((await shellWith(phone.token)).statusCode).toBe(401);
  });

  it("a deactivated user is locked out at the next request, not at token expiry", async () => {
    const s = await loginAs("bhavani");
    await prisma.user.update({ where: { email: emailFor("bhavani") }, data: { active: false } });
    expect((await shellWith(s.token)).statusCode).toBe(401);
    expect((await refreshWith(s.refreshToken)).statusCode).toBe(401);
    await prisma.user.update({ where: { email: emailFor("bhavani") }, data: { active: true } });
  });

  it("rate-limits password guessing on login", async () => {
    const tries = await Promise.all(Array.from({ length: 12 }, () => call({ method: "POST", url: "/v1/auth/login", payload: { email: emailFor("harsha"), password: "wrong" } })));
    expect(tries.some((r) => r.statusCode === 429 && r.json().error.code === "RATE_LIMITED")).toBe(true);
  });
});
