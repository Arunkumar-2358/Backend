import type { Prisma } from "@prisma/client";
import { canReadAll, leaderTeams, stagesOwnedBy, teamsOf, type Actor } from "@contracts/shared/rbac";
import { ENGAGEMENT_STAGES } from "@contracts/shared/engagement";

export * from "@contracts/shared/rbac";

/** Prisma filter for leads the actor may see (PLAN §2 permission rules). */
export function leadScope(a: Actor): Prisma.CandidateWhereInput {
  if (canReadAll(a)) return {};
  if (a.kind !== "user") return {};
  const lt = leaderTeams(a);
  const or: Prisma.CandidateWhereInput[] = [{ ownerUserId: a.id }, { tasks: { some: { assigneeId: a.id, status: "OPEN" } } }];
  if (lt.length) {
    or.push({ stage: { in: stagesOwnedBy(lt) } });
    or.push({ owner: { roles: { some: { team: { code: { in: lt } } } } } });
  }
  // Team 3 sees the enrolled + qualified talent pool: its leader allocates it to Team 2, recruiters match from it.
  if (teamsOf(a).some((t) => t.startsWith("T3"))) or.push({ stage: { in: ENGAGEMENT_STAGES } });
  return { OR: or };
}

export class ForbiddenError extends Error {
  constructor(msg = "You do not have permission to do that") {
    super(msg);
    this.name = "ForbiddenError";
  }
}

export function assert(cond: boolean, msg?: string): asserts cond {
  if (!cond) throw new ForbiddenError(msg);
}
