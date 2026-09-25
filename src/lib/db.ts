import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

/** Run fn in a transaction, or reuse the caller's transaction if one is passed in. */
export async function withTx<T>(db: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (db === (prisma as unknown as Tx)) return prisma.$transaction((tx) => fn(tx), { timeout: 30_000, maxWait: 10_000 });
  return fn(db);
}
