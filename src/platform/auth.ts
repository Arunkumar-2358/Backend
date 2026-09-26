import type { FastifyRequest } from "fastify";
import { loadActor } from "@/lib/actor";
import { UnauthorizedError } from "@/lib/http-errors";
import { SESSION_COOKIE, verifySession } from "@/lib/session-token";
import { isSessionLive } from "@/modules/auth/sessions";
import type { UserActor } from "./endpoint";

export { UnauthorizedError };

type AuthedRequest = FastifyRequest & { actor?: UserActor; sessionId?: string };

export function sessionToken(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return req.cookies?.[SESSION_COOKIE];
}

/**
 * The signed-in user for this request. The token only proves identity: roles
 * are reloaded from the database, and the session must not have been revoked
 * (logout, password change, deactivation, refresh-token theft).
 */
export async function requireUser(req: FastifyRequest): Promise<UserActor> {
  const r = req as AuthedRequest;
  if (r.actor) return r.actor;
  const claims = await verifySession(sessionToken(req));
  if (!claims) throw new UnauthorizedError();
  const [actor, live] = await Promise.all([loadActor(claims.sub), isSessionLive(claims.sid)]);
  if (!actor || actor.kind !== "user" || !live) throw new UnauthorizedError();
  r.actor = actor;
  r.sessionId = claims.sid;
  return actor;
}

/** Session family of the authenticated request (set by requireUser). */
export const sessionIdOf = (req: FastifyRequest) => (req as AuthedRequest).sessionId;
