import { prisma, type Tx } from "./db";
import type { Actor } from "./rbac";

export async function loadActor(userId: string, db: Tx = prisma): Promise<Actor | null> {
  const u = await db.user.findUnique({ where: { id: userId }, include: { roles: { include: { team: true } } } });
  if (!u || !u.active) return null;
  return { kind: "user", id: u.id, name: u.name, email: u.email, roles: u.roles.map((r) => ({ role: r.role, team: r.team.code, category: r.category })) };
}
