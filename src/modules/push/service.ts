import webpush from "web-push";
import { prisma, type Tx } from "@/lib/db";
import type { Actor } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";

export type PushPayload = { title: string; body?: string | null; url?: string | null; tag?: string };

/** Sends one push message. Swappable in tests so nothing hits the real network. */
export type Sender = (subscription: webpush.PushSubscription, payload: PushPayload) => Promise<void>;

let vapidReady = false;
function ensureVapid() {
  if (vapidReady) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) throw new ValidationError("Push notifications are not configured (missing VAPID keys)");
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@nextenti.ai", pub, priv);
  vapidReady = true;
}

const realSender: Sender = async (subscription, payload) => {
  ensureVapid();
  await webpush.sendNotification(subscription, JSON.stringify(payload));
};

let sender: Sender = realSender;
/** Test-only: replace the network call with a spy/fake. Pass `undefined` to restore. */
export function setPushSender(fn?: Sender) {
  sender = fn ?? realSender;
}

export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export async function saveSubscription(
  actor: Extract<Actor, { kind: "user" }>,
  input: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string },
  db: Tx = prisma,
) {
  if (!input.endpoint || !input.keys?.p256dh || !input.keys?.auth) throw new ValidationError("Invalid push subscription");
  await db.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: { userId: actor.id, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: input.userAgent },
    update: { userId: actor.id, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: input.userAgent, lastSeenAt: new Date() },
  });
  await audit(actor, "SETTING_CHANGE", "user", actor.id, { pushSubscribed: true }, db);
}

export async function removeSubscription(actor: Extract<Actor, { kind: "user" }>, endpoint: string, db: Tx = prisma) {
  await db.pushSubscription.deleteMany({ where: { endpoint, userId: actor.id } });
  await audit(actor, "SETTING_CHANGE", "user", actor.id, { pushSubscribed: false }, db);
}

export async function subscriptionCount(userId: string, db: Tx = prisma) {
  return db.pushSubscription.count({ where: { userId } });
}

/**
 * Best-effort push to every device a user has enabled notifications on. Never
 * throws — a missing config, a dead subscription (410/404) or a network error
 * just means no push goes out; the in-app bell (Notification row) still exists.
 * Dead subscriptions are pruned so the list doesn't grow stale.
 */
export async function pushToUser(userId: string, payload: PushPayload, db: Tx = prisma) {
  if (!pushConfigured()) return { sent: 0, pruned: 0 };
  const subs = await db.pushSubscription.findMany({ where: { userId } });
  let sent = 0;
  const dead: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) dead.push(s.endpoint);
      }
    }),
  );
  if (dead.length) await db.pushSubscription.deleteMany({ where: { endpoint: { in: dead } } });
  return { sent, pruned: dead.length };
}
