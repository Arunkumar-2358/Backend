import type { MainCategory, TeamCode } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";

/**
 * Configurable routing (Admin → Assignment rules). Picks the highest-priority
 * active rule for the team + category (falling back to category-agnostic rules).
 * Ties are broken by the fewest open tasks, so load spreads across agents.
 */
export async function pickAssignee(team: TeamCode, category: MainCategory | null | undefined, db: Tx = prisma): Promise<string | null> {
  const rules = await db.assignmentRule.findMany({
    where: { teamCode: team, active: true, user: { active: true }, OR: [{ category: category ?? undefined }, { category: null }] },
    orderBy: [{ priority: "desc" }],
  });
  if (!rules.length) return null;
  const specific = rules.filter((r) => category && r.category === category);
  const pool = specific.length ? specific : rules.filter((r) => r.category === null);
  if (!pool.length) return null;
  const top = pool[0].priority;
  const candidates = pool.filter((r) => r.priority === top).map((r) => r.userId);
  if (candidates.length === 1) return candidates[0];
  const loads = await db.task.groupBy({ by: ["assigneeId"], where: { assigneeId: { in: candidates }, status: "OPEN" }, _count: true });
  const load = new Map(loads.map((l) => [l.assigneeId, l._count]));
  return candidates.sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0))[0];
}

export async function teamMembers(team: TeamCode | TeamCode[], db: Tx = prisma) {
  const codes = Array.isArray(team) ? team : [team];
  return db.user.findMany({
    where: { active: true, roles: { some: { team: { code: { in: codes } } } } },
    include: { roles: { include: { team: true } } },
    orderBy: { name: "asc" },
  });
}
