import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { resetDb, nextMobile } from "../helpers";
import { call } from "./client";

beforeEach(resetDb);

const sign = (raw: string) => createHmac("sha256", process.env.NT_WEBHOOK_SECRET!).update(raw).digest("hex");

describe("HTTP: integrations", () => {
  it("accepts a correctly signed NT enrolment webhook and rejects a bad signature", async () => {
    const raw = JSON.stringify({ mobile: nextMobile(), name: "Webhook Nurse" });
    const bad = await call({ method: "POST", url: "/v1/webhooks/nt-enrolment", payload: raw, headers: { "content-type": "application/json", "x-nt-signature": "0".repeat(64) } });
    expect(bad.statusCode).toBe(401);
    const ok = await call({ method: "POST", url: "/v1/webhooks/nt-enrolment", payload: raw, headers: { "content-type": "application/json", "x-nt-signature": `sha256=${sign(raw)}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ok).toBe(true);
  });

  it("logs a telephony missed call from a form-encoded POST and a query-only GET", async () => {
    const token = process.env.TELEPHONY_WEBHOOK_TOKEN;
    expect((await call({ method: "POST", url: "/v1/telephony/missed-call?token=wrong", payload: "From=9876543210" })).statusCode).toBe(401);
    const form = await call({ method: "POST", url: `/v1/telephony/missed-call?token=${token}`, payload: `From=${nextMobile()}&CallSid=abc`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(form.statusCode).toBe(200);
    const get = await call({ method: "GET", url: `/v1/telephony/missed-call?token=${token}&CallFrom=${nextMobile()}` });
    expect(get.statusCode).toBe(200);
    expect(await prisma.missedCall.count()).toBe(2);
  });

  it("runs due jobs only with the cron secret", async () => {
    expect((await call({ method: "POST", url: "/v1/cron/run-jobs" })).statusCode).toBe(401);
    const res = await call({ method: "POST", url: "/v1/cron/run-jobs", headers: { "x-cron-secret": process.env.CRON_SECRET } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

describe("HTTP: push, files and exports", () => {
  it("subscribes and unsubscribes a device", async () => {
    const sub = { endpoint: "https://push.example.com/ep-1", keys: { p256dh: "p", auth: "a" } };
    expect((await call({ method: "POST", url: "/v1/push/subscriptions", payload: sub })).statusCode).toBe(401);
    expect((await call({ method: "POST", url: "/v1/push/subscriptions", payload: sub, as: "jennifer" })).statusCode).toBe(201);
    expect((await call({ method: "POST", url: "/v1/push/subscriptions", payload: { endpoint: "nope" }, as: "jennifer" })).statusCode).toBe(422);
    expect((await call({ method: "DELETE", url: "/v1/push/subscriptions", payload: { endpoint: sub.endpoint }, as: "jennifer" })).statusCode).toBe(200);
    expect(await prisma.pushSubscription.count()).toBe(0);
  });

  it("returns 404 for unknown files and blocks path traversal", async () => {
    expect((await call({ method: "GET", url: "/v1/files/resumes/missing.pdf", as: "admin" })).statusCode).toBe(404);
    expect((await call({ method: "GET", url: "/v1/files/..%2F..%2Fetc%2Fpasswd", as: "admin" })).statusCode).toBe(404);
  });

  it("gates the KPI export by role and returns an xlsx", async () => {
    expect((await call({ method: "GET", url: "/v1/kpi/export", as: "jennifer" })).statusCode).toBe(403);
    const res = await call({ method: "GET", url: "/v1/kpi/export?period=WEEK", as: "admin" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.rawPayload.subarray(0, 2).toString()).toBe("PK");
  });
});
