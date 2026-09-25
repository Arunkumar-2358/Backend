import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route } from "@/http/route";
import { idParam, pageQuery, queryBool } from "@/http/schemas";
import { listNotifications, markAllRead, markRead } from "./service";

export async function notificationRoutes(app: FastifyInstance) {
  route(app, "GET /v1/notifications", {
    summary: "The signed-in user's notifications, newest first",
    query: z.object({ page: pageQuery.optional(), unread: queryBool.optional(), kind: z.string().max(40).optional() }),
    handler: async ({ actor, query }) => listNotifications(actor.id, query),
  });

  route(app, "POST /v1/notifications/{id}/read", {
    params: idParam,
    handler: async ({ actor, params }) => {
      await markRead(actor.id, params.id);
      return { message: "Marked read" };
    },
  });

  route(app, "POST /v1/notifications/read-all", {
    handler: async ({ actor }) => {
      await markAllRead(actor.id);
      return { message: "All notifications marked read" };
    },
  });
}
