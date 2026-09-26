import { Controller, Module } from "@nestjs/common";
import { z } from "zod";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { idParam, pageQuery, queryBool } from "@/http/schemas";
import { listNotifications, markAllRead, markRead } from "./service";

@Controller()
export class NotificationsController {
  @Endpoint("GET /v1/notifications", {
    summary: "The signed-in user's notifications, newest first",
    query: z.object({ page: pageQuery.optional(), unread: queryBool.optional(), kind: z.string().max(40).optional() }),
  })
  async list({ actor, query }: Ctx<"GET /v1/notifications">) {
    return listNotifications(actor.id, query);
  }

  @Endpoint("POST /v1/notifications/{id}/read", {
    params: idParam,
  })
  async read({ actor, params }: Ctx<"POST /v1/notifications/{id}/read">) {
    await markRead(actor.id, params.id);
    return { message: "Marked read" };
  }

  @Endpoint("POST /v1/notifications/read-all")
  async readAll({ actor }: Ctx<"POST /v1/notifications/read-all">) {
    await markAllRead(actor.id);
    return { message: "All notifications marked read" };
  }
}

@Module({ controllers: [NotificationsController] })
export class NotificationsModule {}
