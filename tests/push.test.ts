import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { saveSubscription, removeSubscription, subscriptionCount, pushToUser, pushConfigured, setPushSender } from "@/modules/push/service";
import { resetDb, as, userId } from "./helpers";

const sub = (n: number) => ({ endpoint: `https://push.example.com/ep-${n}`, keys: { p256dh: `p256-${n}`, auth: `auth-${n}` } });

beforeEach(resetDb);
afterEach(() => setPushSender(undefined));

describe("push subscriptions", () => {
  it("is configured from the seeded test env", () => {
    expect(pushConfigured()).toBe(true);
  });

  it("saves, re-saves (upsert) and removes a subscription, each audited", async () => {
    const actor = await as("jennifer");
    if (actor.kind !== "user") throw new Error();
    await saveSubscription(actor, sub(1));
    expect(await subscriptionCount(actor.id)).toBe(1);
    await saveSubscription(actor, sub(1)); // same endpoint again → upsert, not a duplicate
    expect(await subscriptionCount(actor.id)).toBe(1);
    await saveSubscription(actor, sub(2));
    expect(await subscriptionCount(actor.id)).toBe(2);
    await removeSubscription(actor, sub(1).endpoint);
    expect(await subscriptionCount(actor.id)).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: actor.id, action: "SETTING_CHANGE" } })).toBe(4);
  });

  it("only removes the caller's own subscription, never someone else's", async () => {
    const jen = await as("jennifer");
    const bh = await as("bhavani");
    if (jen.kind !== "user" || bh.kind !== "user") throw new Error();
    await saveSubscription(jen, sub(1));
    await removeSubscription(bh, sub(1).endpoint); // bhavani doesn't own this endpoint
    expect(await subscriptionCount(jen.id)).toBe(1);
  });

  it("pushes to every device, and prunes a dead (410) subscription without breaking the others", async () => {
    const actor = await as("jennifer");
    if (actor.kind !== "user") throw new Error();
    await saveSubscription(actor, sub(1));
    await saveSubscription(actor, sub(2));
    const sent: string[] = [];
    setPushSender(async (s, payload) => {
      sent.push(s.endpoint);
      if (s.endpoint === sub(2).endpoint) {
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      }
      expect(payload.title).toBe("Hello");
    });
    const r = await pushToUser(actor.id, { title: "Hello", body: "World", url: "/tasks" });
    expect(sent.sort()).toEqual([sub(1).endpoint, sub(2).endpoint]);
    expect(r).toEqual({ sent: 1, pruned: 1 });
    expect(await subscriptionCount(actor.id)).toBe(1); // the dead one is gone, the live one stays
  });

  it("does nothing (no throw) when a user has no subscriptions", async () => {
    const id = await userId("harsha");
    const r = await pushToUser(id, { title: "x" });
    expect(r).toEqual({ sent: 0, pruned: 0 });
  });
});
