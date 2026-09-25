import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route } from "@/http/route";
import { HttpError } from "@/plugins/errors";
import { saveSubscription, removeSubscription, pushConfigured } from "./service";

export async function pushRoutes(app: FastifyInstance) {
  route(app, "POST /v1/push/subscriptions", {
    summary: "Subscribe this browser/device to push notifications",
    body: z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }) }),
    status: 201,
    handler: async ({ actor, body, req }) => {
      if (!pushConfigured()) throw new HttpError(503, "INTERNAL", "Push notifications are not configured on this server");
      await saveSubscription(actor, { ...body, userAgent: req.headers["user-agent"] });
      return { ok: true as const };
    },
  });

  route(app, "DELETE /v1/push/subscriptions", {
    summary: "Unsubscribe this browser/device",
    body: z.object({ endpoint: z.string().min(1) }),
    handler: async ({ actor, body }) => {
      await removeSubscription(actor, body.endpoint);
      return { ok: true as const };
    },
  });
}
