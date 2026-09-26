import { Controller, Module } from "@nestjs/common";
import { z } from "zod";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { HttpError } from "@/lib/http-errors";
import { saveSubscription, removeSubscription, pushConfigured } from "./service";

@Controller()
export class PushController {
  @Endpoint("POST /v1/push/subscriptions", {
    summary: "Subscribe this browser/device to push notifications",
    body: z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }) }),
    status: 201,
  })
  async subscribe({ actor, body, req }: Ctx<"POST /v1/push/subscriptions">) {
    if (!pushConfigured()) throw new HttpError(503, "INTERNAL", "Push notifications are not configured on this server");
    await saveSubscription(actor, { ...body, userAgent: req.headers["user-agent"] });
    return { ok: true as const };
  }

  @Endpoint("DELETE /v1/push/subscriptions", {
    summary: "Unsubscribe this browser/device",
    body: z.object({ endpoint: z.string().min(1) }),
  })
  async unsubscribe({ actor, body }: Ctx<"DELETE /v1/push/subscriptions">) {
    await removeSubscription(actor, body.endpoint);
    return { ok: true as const };
  }
}

@Module({ controllers: [PushController] })
export class PushModule {}
