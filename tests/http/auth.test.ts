import { describe, it, expect, beforeAll } from "vitest";
import { DEV_PASSWORD, emailFor } from "@/modules/seed/core";
import { resetDb } from "../helpers";
import { call } from "./client";

beforeAll(resetDb);

describe("HTTP: auth", () => {
  it("logs in with valid credentials and returns a usable token", async () => {
    const res = await call({ method: "POST", url: "/v1/auth/login", payload: { email: emailFor("jennifer"), password: DEV_PASSWORD } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe(emailFor("jennifer"));
    expect(body.expiresIn).toBe(12 * 3600);
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
