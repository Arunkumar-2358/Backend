import { Controller, Module } from "@nestjs/common";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { parseThemePref } from "@/lib/theme";
import { REFRESH_COOKIE } from "@/lib/session-token";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { requireUser, sessionIdOf, UnauthorizedError } from "@/platform/auth";
import { latest, unreadCount } from "@/modules/notifications/service";
import { login, logout, refresh } from "./service";
import { revokeUserSessions } from "./sessions";
import type { FastifyRequest } from "fastify";

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });

@Controller()
export class AuthController {
  @Endpoint("POST /v1/auth/login", {
    auth: "public",
    summary: "Exchange email + password for an access token and a refresh token",
    body: z.object({ email: z.string().email(), password: z.string().min(1).max(200) }),
    throttle: { limit: 10, ttlMs: 60_000 },
  })
  async login({ body, req }: Ctx<"POST /v1/auth/login", null>) {
    const result = await login(body.email, body.password, meta(req));
    if (!result) throw new UnauthorizedError("Invalid email or password");
    return result;
  }

  @Endpoint("POST /v1/auth/refresh", {
    auth: "public",
    summary: "Rotate a refresh token into a new access + refresh pair (single use)",
    body: z.object({ refreshToken: z.string().min(10).max(500) }),
    throttle: { limit: 60, ttlMs: 60_000 },
  })
  async refresh({ body, req }: Ctx<"POST /v1/auth/refresh", null>) {
    const result = await refresh(body.refreshToken, meta(req));
    if (!result) throw new UnauthorizedError("Session expired, please sign in again");
    return result;
  }

  @Endpoint("POST /v1/auth/logout", {
    auth: "public",
    summary: "End this device's session (refresh token in the body, or the access token)",
    body: z.object({ refreshToken: z.string().max(500).optional() }).default({}),
    throttle: { limit: 30, ttlMs: 60_000 },
  })
  async logout({ body, req }: Ctx<"POST /v1/auth/logout", null>) {
    const fromAccess = await requireUser(req).then(() => sessionIdOf(req)).catch(() => undefined);
    await logout(body.refreshToken ?? req.cookies?.[REFRESH_COOKIE], fromAccess);
    return { message: "Signed out" };
  }

  @Endpoint("POST /v1/auth/logout-all", {
    summary: "Sign out every device of the current user",
    body: z.object({ keepCurrent: z.boolean().optional() }).default({}),
  })
  async logoutAll({ actor, body, req }: Ctx<"POST /v1/auth/logout-all">) {
    const r = await revokeUserSessions(actor.id, "logout all devices", { exceptFamilyId: body.keepCurrent ? sessionIdOf(req) : undefined });
    return { revoked: r.count };
  }

  @Endpoint("GET /v1/me/shell", { summary: "Signed-in user plus the counters and notifications the app shell shows" })
  async shell({ actor }: Ctx<"GET /v1/me/shell">) {
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
  }
}

@Module({ controllers: [AuthController] })
export class AuthModule {}
