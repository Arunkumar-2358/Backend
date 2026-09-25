import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType, ZodTypeDef } from "zod";
import type { ApiRoutes } from "@contracts";
import type { Actor } from "@/lib/rbac";
import { requireUser } from "@/plugins/auth";
import { ForbiddenError } from "@/lib/rbac";
import { canAccessPath } from "@contracts/shared/access";

type Key = keyof ApiRoutes & string;
type Part<K extends Key, P extends string> = P extends keyof ApiRoutes[K] ? NonNullable<ApiRoutes[K][P]> : undefined;
type Schema<T> = ZodType<T, ZodTypeDef, unknown>;
export type UserActor = Extract<Actor, { kind: "user" }>;

type Ctx<K extends Key, A> = {
  actor: A;
  params: Part<K, "params">;
  query: Part<K, "query">;
  body: Part<K, "body">;
  req: FastifyRequest;
  reply: FastifyReply;
};

type Common<K extends Key> = {
  summary?: string;
  params?: Schema<Part<K, "params">>;
  query?: Schema<Part<K, "query">>;
  body?: Schema<Part<K, "body">>;
  status?: number;
  /** Per-route Fastify config, e.g. { rateLimit: { max: 10, timeWindow: "1 minute" } }. */
  config?: Record<string, unknown>;
};

type Options<K extends Key> =
  | (Common<K> & { auth?: "user"; handler: (ctx: Ctx<K, UserActor>) => Promise<ApiRoutes[K]["response"]> })
  | (Common<K> & { auth: "public"; handler: (ctx: Ctx<K, null>) => Promise<ApiRoutes[K]["response"]> });

const toFastifyPath = (p: string) => p.replace(/\{(\w+)\}/g, ":$1");

/** API area (first segment after /v1) → the app area whose role list guards it. */
const AREA_PAGE: Record<string, string> = {
  admin: "/admin",
  imports: "/import",
  queue: "/queue",
  "missed-calls": "/missed-calls",
  scrutiny: "/scrutiny",
  availability: "/availability",
  vacancies: "/vacancies",
  recruitment: "/recruitment",
  evaluations: "/evaluations",
  "evaluation-templates": "/evaluations",
  // red-flags is not listed: CAPA action owners outside the page's roles must still reach their own
  // actions, and every red-flag endpoint scopes its data per caller.
};

/**
 * Register an endpoint declared in contracts/ApiRoutes. The key fixes the
 * method, path, input schemas and response type, so the handler cannot drift
 * from the contract the web client is compiled against.
 */
export function route<K extends Key>(app: FastifyInstance, key: K, opts: Options<K>) {
  const [method, path] = key.split(" ") as [string, string];
  const tag = path.split("/")[2];
  const page = tag ? AREA_PAGE[tag] : undefined;
  app.route({
    method: method as "GET",
    url: toFastifyPath(path),
    config: opts.config,
    schema: Object.fromEntries(
      Object.entries({
        tags: tag ? [tag] : undefined,
        summary: opts.summary,
        params: opts.params,
        querystring: opts.query,
        body: opts.body,
        security: opts.auth === "public" ? [] : undefined,
      }).filter(([, v]) => v !== undefined),
    ),
    handler: async (req, reply) => {
      const actor = opts.auth === "public" ? null : await requireUser(req);
      if (actor && page && !canAccessPath(page, actor.roles.map((r) => r.role))) throw new ForbiddenError("You do not have access to this area");
      const ctx = { actor, params: req.params, query: req.query, body: req.body, req, reply };
      const result = await (opts.handler as (c: typeof ctx) => Promise<unknown>)(ctx);
      if (opts.status) reply.status(opts.status);
      return result;
    },
  });
}
