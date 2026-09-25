import type { InjectOptions } from "fastify";
import { buildApp, type App } from "@/app";
import { signSession } from "@/lib/session-token";
import { prisma } from "@/lib/db";
import { emailFor } from "@/modules/seed/core";

let app: App | undefined;

export async function http() {
  app ??= await buildApp({ docs: false });
  return app;
}

/** A bearer token for a seeded user, e.g. tokenFor("jennifer"). */
export async function tokenFor(key: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email: emailFor(key) }, include: { roles: true } });
  return signSession({ sub: u.id, name: u.name, roles: u.roles.map((r) => r.role) });
}

export async function call(opts: InjectOptions & { as?: string }) {
  const { as, headers, ...rest } = opts;
  const auth = as ? { authorization: `Bearer ${await tokenFor(as)}` } : {};
  return (await http()).inject({ ...rest, headers: { ...headers, ...auth } });
}
