import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route } from "@/http/route";
import { UnauthorizedError } from "@/plugins/auth";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { parseThemePref } from "@/lib/theme";
import { latest, unreadCount } from "@/modules/notifications/service";
import { login } from "./service";

export async function authRoutes(app: FastifyInstance) {
  route(app, "POST /v1/auth/login", {
    auth: "public",
    summary: "Exchange email + password for a session token",
    body: z.object({ email: z.string().email(), password: z.string().min(1) }),
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    handler: async ({ body }) => {
      const result = await login(body.email, body.password);
      if (!result) throw new UnauthorizedError("Invalid email or password");
      return result;
    },
  });

  route(app, "GET /v1/me/shell", {
    summary: "Signed-in user plus the counters and notifications the app shell shows",
    handler: async ({ actor }) => {
      const [me, overdueTasks, unread, notifications] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { theme: true } }),
        prisma.task.count({ where: { assigneeId: actor.id, status: "OPEN", dueAt: { lte: now() } } }),
        unreadCount(actor.id),
        latest(actor.id, 8),
      ]);
      return {
        user: { id: actor.id, name: actor.name, email: actor.email, theme: parseThemePref(me.theme), roles: actor.roles },
        overdueTasks,
        unread,
        notifications: notifications.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, readAt: n.readAt, createdAt: n.createdAt })),
      };
    },
  });
}
