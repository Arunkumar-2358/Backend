export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushRoutes {
  "POST /v1/push/subscriptions": { body: PushSubscriptionBody; response: { ok: true } };
  "DELETE /v1/push/subscriptions": { body: { endpoint: string }; response: { ok: true } };
}
