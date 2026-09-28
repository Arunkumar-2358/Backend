import { Injectable, Logger, type CanActivate, type ExecutionContext } from "@nestjs/common";

/** Failed-or-not login attempts per IP across all emails (an office NAT stays well under this). */
export const LOGIN_PER_IP = { limit: 30, ttlMs: 60_000 };
import { ThrottlerException, ThrottlerGuard } from "@nestjs/throttler";
import { Reflector } from "@nestjs/core";
import { Inject } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ForbiddenError } from "@/lib/rbac";
import { canAccessPath } from "@contracts/shared/access";
import { ENDPOINT_META, type EndpointMeta } from "./endpoint";
import { requireUser } from "./auth";

/** API area (first segment after /v1) → the app area whose role list guards it. */
const AREA_PAGE: Record<string, string> = {
  admin: "/admin",
  imports: "/import",
  queue: "/queue",
  "missed-calls": "/missed-calls",
  scrutiny: "/scrutiny",
  availability: "/availability",
  engagement: "/engagement",
  "cold-calls": "/cold-calls",
  allocation: "/allocation",
  vacancies: "/vacancies",
  recruitment: "/recruitment",
  evaluations: "/evaluations",
  "evaluation-templates": "/evaluations",
  // red-flags is not listed: CAPA action owners outside the page's roles must still reach their own
  // actions, and every red-flag endpoint scopes its data per caller.
};

/**
 * Global guard. Every route is authenticated unless declared `auth: "public"`;
 * a handler without endpoint metadata is denied (fail closed). Typed JSON
 * endpoints also get the area check that mirrors the web app's role table.
 */
@Injectable()
export class ApiAuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.get<EndpointMeta | undefined>(ENDPOINT_META, ctx.getHandler());
    if (meta?.auth === "public") return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const actor = await requireUser(req);
    if (!meta) throw new ForbiddenError("This route is not declared as an endpoint");
    if (!meta.raw) {
      const page = AREA_PAGE[meta.path.split("/")[2] ?? ""];
      if (page && !canAccessPath(page, actor.roles.map((r) => r.role))) throw new ForbiddenError("You do not have access to this area");
    }
    return true;
  }
}

/**
 * Rate limiting keyed by client IP. Login is keyed by IP + email so one office
 * behind a NAT is not locked out by a colleague's typos, while guessing one
 * account's password is still capped.
 */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  private readonly log = new Logger("RateLimit");

  /**
   * Fails OPEN if the rate-limit store (Redis) is unavailable: throttling protects the service, and
   * refusing every request during a Redis outage would be a worse outage. Logged loudly.
   */
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    try {
      const ok = await super.canActivate(ctx);
      const req = ctx.switchToHttp().getRequest<FastifyRequest>();
      if (ok && req.url.startsWith("/v1/auth/login")) await this.loginPerIp(req);
      return ok;
    } catch (e) {
      if (e instanceof ThrottlerException) throw e;
      this.log.error(`rate-limit store unavailable, allowing request: ${(e as Error).message}`);
      return true;
    }
  }

  /** Aggregate cap across all emails from one IP, so rotating emails cannot bypass the per-account limit. */
  private async loginPerIp(req: FastifyRequest) {
    const r = await this.storageService.increment(`login-ip:${req.ip}`, LOGIN_PER_IP.ttlMs, LOGIN_PER_IP.limit, LOGIN_PER_IP.ttlMs, "login-ip");
    if (r.totalHits > LOGIN_PER_IP.limit) throw new ThrottlerException();
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const r = req as unknown as FastifyRequest<{ Body: { email?: unknown } }>;
    if (r.url.startsWith("/v1/auth/login") && typeof r.body?.email === "string") return `${r.ip}:${r.body.email.trim().toLowerCase()}`;
    return r.ip;
  }
}
