import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { now, advanceClock, setClock, DAY } from "@/lib/clock";
import { decryptCandidate } from "@/modules/candidates/service";
import { sendReengagement } from "@/modules/engagement/service";
import { resetDb, as, userId } from "../helpers";
import { driveTo } from "../drive";
import { call } from "./client";

beforeEach(resetDb);

const hmac = (secret: string, raw: string) => createHmac("sha256", secret).update(raw).digest("hex");
const json = { "content-type": "application/json" };
const mobileOf = async (id: string) => decryptCandidate(await prisma.candidate.findUniqueOrThrow({ where: { id } })).mobile!;

describe("HTTP: allocation", () => {
  it("is open to Team 3 and the Team 2 leader, and only the Team 3 leader allocates", async () => {
    const { id } = await driveTo("QUALIFIED", { mainCategory: "PHARMACY", jobTitle: "Pharmacist" }, { allocate: false });
    expect((await call({ method: "GET", url: "/v1/allocation", as: "jennifer" })).statusCode).toBe(403);
    expect((await call({ method: "GET", url: "/v1/allocation", as: "amos" })).statusCode).toBe(403);
    const ro = (await call({ method: "GET", url: "/v1/allocation", as: "harsha" })).json();
    expect(ro.canAllocate).toBe(false);
    expect(ro.pending.map((p: { id: string }) => p.id)).toEqual([id]);
    expect((await call({ method: "GET", url: "/v1/allocation?category=PHARMACY", as: "dixha" })).json().total).toBe(1);

    const amos = await userId("amos");
    const denied = await call({ method: "POST", url: "/v1/allocation", payload: { sourcerId: amos, category: "PHARMACY" }, as: "harsha" });
    expect(denied.statusCode).toBe(403);
    expect((await call({ method: "POST", url: "/v1/allocation", payload: { sourcerId: amos }, as: "sanjay" })).statusCode).toBe(422);

    const ok = await call({ method: "POST", url: "/v1/allocation", payload: { sourcerId: amos, category: "PHARMACY" }, as: "sanjay" });
    expect(ok.json().message).toBe("1 lead allocated to Amos");
    const after = (await call({ method: "GET", url: "/v1/allocation", as: "sanjay" })).json();
    expect(after.total).toBe(0);
    expect(after.recent[0]).toMatchObject({ id, allocatedBy: "Sanjay", owner: { name: "Amos" } });
    expect(after.sourcers.find((s: { id: string }) => s.id === amos)).toMatchObject({ category: "PHARMACY", load: 1 });
  });
});

describe("HTTP: engagement", () => {
  it("lists by tier, confirms job intent and sends the WhatsApp", async () => {
    const { id } = await driveTo("ACTIVE");
    advanceClock(61 * DAY);
    expect((await call({ method: "GET", url: "/v1/engagement", as: "jennifer" })).statusCode).toBe(403);
    const cold = (await call({ method: "GET", url: "/v1/engagement?tier=COLD", as: "srividya" })).json();
    expect(cold.scope).toBe("mine");
    expect(cold.counts.COLD).toBe(1);
    expect(cold.rows[0]).toMatchObject({ id, tier: "COLD" });
    expect((await call({ method: "GET", url: "/v1/engagement?tier=HOT", as: "srividya" })).statusCode).toBe(422);

    // Team 3 can see it but not act on it.
    expect((await call({ method: "GET", url: "/v1/engagement", as: "sanjay" })).json()).toMatchObject({ scope: "all", canAct: false });
    expect((await call({ method: "POST", url: `/v1/engagement/${id}/job-intent`, payload: {}, as: "sanjay" })).statusCode).toBe(403);

    // Only the lead's Team 2 owner (or the Team 2 leader) can send the re-engagement WhatsApp.
    expect((await call({ method: "POST", url: `/v1/engagement/${id}/reengage`, as: "sanjay" })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: `/v1/engagement/${id}/reengage`, as: "amos" })).statusCode).toBe(403);
    expect(await prisma.message.count({ where: { candidateId: id, templateKey: "reengage_cold_whatsapp" } })).toBe(0);

    expect((await call({ method: "POST", url: `/v1/engagement/${id}/reengage`, as: "srividya" })).statusCode).toBe(200);
    expect(await prisma.message.count({ where: { candidateId: id, templateKey: "reengage_cold_whatsapp" } })).toBe(1);
    const res = await call({ method: "POST", url: `/v1/engagement/${id}/job-intent`, payload: { notes: "Needs a job in Chennai" }, as: "srividya" });
    expect(res.json().message).toMatch(/Super active/);
    const row = (await call({ method: "GET", url: "/v1/engagement?tier=SUPER_ACTIVE", as: "srividya" })).json().rows[0];
    expect(row).toMatchObject({ id, tier: "SUPER_ACTIVE" });
  });
});

describe("HTTP: engagement webhooks", () => {
  it("records NT platform visits (single or batch) with a valid signature", async () => {
    setClock(new Date("2026-09-01T05:00:00Z"));
    const { id } = await driveTo("ACTIVE");
    const secret = process.env.NT_WEBHOOK_SECRET!;
    const one = JSON.stringify({ mobile: await mobileOf(id) });
    expect((await call({ method: "POST", url: "/v1/webhooks/nt-activity", payload: one, headers: { ...json, "x-nt-signature": "0".repeat(64) } })).statusCode).toBe(401);
    const ok = await call({ method: "POST", url: "/v1/webhooks/nt-activity", payload: one, headers: { ...json, "x-nt-signature": hmac(secret, one) } });
    expect(ok.json()).toEqual({ ok: true, matched: 1, unknown: 0 });
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id } })).lastPlatformVisitAt).toEqual(now());

    const batch = JSON.stringify({ visits: [{ mobile: await mobileOf(id), visitedAt: "2026-01-01T00:00:00Z" }, { mobile: "12" }] });
    expect((await call({ method: "POST", url: "/v1/webhooks/nt-activity", payload: batch, headers: { ...json, "x-nt-signature": hmac(secret, batch) } })).json()).toMatchObject({ matched: 1, unknown: 1 });
    const bad = JSON.stringify({ visits: [{ mobile: "9876543210", visitedAt: "yesterday" }] });
    expect((await call({ method: "POST", url: "/v1/webhooks/nt-activity", payload: bad, headers: { ...json, "x-nt-signature": hmac(secret, bad) } })).statusCode).toBe(400);
  });

  it("verifies the WhatsApp webhook and turns a signed 'yes' button reply into super active", async () => {
    const verify = await call({ method: "GET", url: `/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${process.env.WHATSAPP_VERIFY_TOKEN}&hub.challenge=12345` });
    expect(verify.statusCode).toBe(200);
    expect(verify.body).toBe("12345");
    expect((await call({ method: "GET", url: "/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1" })).statusCode).toBe(403);

    const { id } = await driveTo("ACTIVE");
    advanceClock(61 * DAY);
    await sendReengagement(await as("srividya"), id);

    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { messages: [{ id: "wamid.btn", from: `91${await mobileOf(id)}`, timestamp: String(Math.floor(now().getTime() / 1000)), type: "interactive", interactive: { button_reply: { id: "JOB_YES", title: "Yes, I need a job" } } }], statuses: [] } }] }],
    });
    expect((await call({ method: "POST", url: "/v1/webhooks/whatsapp", payload: raw, headers: { ...json, "x-hub-signature-256": "sha256=" + "0".repeat(64) } })).statusCode).toBe(401);
    const res = await call({ method: "POST", url: "/v1/webhooks/whatsapp", payload: raw, headers: { ...json, "x-hub-signature-256": `sha256=${hmac(process.env.WHATSAPP_APP_SECRET!, raw)}` } });
    expect(res.json()).toMatchObject({ ok: true, stored: 1, looking: 1 });
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id } })).jobIntentAt).toEqual(now());
  });
});
