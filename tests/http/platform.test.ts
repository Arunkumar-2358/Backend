import { describe, it, expect, beforeAll } from "vitest";
import { endpointRegistry } from "@/platform/endpoint";
import { buildOpenApi } from "@/platform/openapi";
import { resetDb } from "../helpers";
import { call, http } from "./client";

beforeAll(async () => {
  await resetDb();
  await http();
});

describe("HTTP platform", () => {
  it("allows CORS only from configured origins", async () => {
    const ok = await call({ method: "OPTIONS", url: "/v1/me/shell", headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    const evil = await call({ method: "OPTIONS", url: "/v1/me/shell", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("echoes a well-formed x-request-id and replaces a malformed one", async () => {
    const given = await call({ method: "GET", url: "/health", headers: { "x-request-id": "abc-123" } });
    expect(given.headers["x-request-id"]).toBe("abc-123");
    for (const bad of ["has spaces", "x".repeat(300), "a;b=c"]) {
      const res = await call({ method: "GET", url: "/health", headers: { "x-request-id": bad } });
      expect(res.headers["x-request-id"], bad).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("sends security headers", async () => {
    const res = await call({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("reports readiness of its dependencies", async () => {
    const res = await call({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", db: "up" });
  });

  it("keeps /metrics closed when no token is configured", async () => {
    expect((await call({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
  });

  it("declares every route once, and documents every non-hidden one", () => {
    const keys = endpointRegistry.map((e) => `${e.method} ${e.path}`);
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    const doc = buildOpenApi();
    for (const e of endpointRegistry.filter((x) => !x.hidden)) expect(doc.paths[e.path]?.[e.method.toLowerCase()], `${e.method} ${e.path}`).toBeDefined();
  });

  it("only exposes public routes that authenticate themselves", () => {
    const pub = endpointRegistry.filter((e) => e.auth === "public").map((e) => `${e.method} ${e.path}`).sort();
    expect(pub).toEqual(
      [
        "GET /health",
        "GET /health/ready",
        "GET /metrics",
        "GET /v1/cron/run-jobs",
        "GET /v1/telephony/missed-call",
        "POST /v1/auth/login",
        "POST /v1/auth/logout",
        "POST /v1/auth/refresh",
        "POST /v1/cron/run-jobs",
        "POST /v1/telephony/missed-call",
        "POST /v1/webhooks/nt-enrolment",
      ].sort(),
    );
  });
});
