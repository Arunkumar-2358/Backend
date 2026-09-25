import type { FastifyRequest } from "fastify";
import { loadActor } from "@/lib/actor";
import { SESSION_COOKIE, verifySession } from "@/lib/session-token";
import type { Actor } from "@/lib/rbac";

export class UnauthorizedError extends Error {
  constructor(message = "Sign in required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

type UserActor = Extract<Actor, { kind: "user" }>;
const cache = new WeakMap<FastifyRequest, UserActor>();

export function sessionToken(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return req.cookies?.[SESSION_COOKIE];
}

/** The signed-in user for this request. Roles are reloaded from the database, never trusted from the token. */
export async function requireUser(req: FastifyRequest): Promise<UserActor> {
  const hit = cache.get(req);
  if (hit) return hit;
  const claims = await verifySession(sessionToken(req));
  const actor = claims ? await loadActor(claims.sub) : null;
  if (!actor || actor.kind !== "user") throw new UnauthorizedError();
  cache.set(req, actor);
  return actor;
}
