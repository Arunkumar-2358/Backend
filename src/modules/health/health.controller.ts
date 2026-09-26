import { Controller, Module } from "@nestjs/common";
import { prisma } from "@/lib/db";
import { RawEndpoint, type RawCtx } from "@/platform/endpoint";
import { redisEnabled, redisConnection } from "@/platform/redis";

let redis: ReturnType<typeof redisConnection> | undefined;

async function redisUp(): Promise<boolean | null> {
  if (!redisEnabled()) return null;
  redis ??= redisConnection({ maxRetriesPerRequest: 1, connectTimeout: 2000 });
  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}

@Controller()
export class HealthController {
  @RawEndpoint("GET", "/health", { auth: "public", hidden: true })
  async live() {
    return { status: "ok" };
  }

  /** Readiness: the database (and Redis when configured) must answer. */
  @RawEndpoint("GET", "/health/ready", { auth: "public", hidden: true })
  async ready({ reply }: RawCtx) {
    const [db, r] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      redisUp(),
    ]);
    const ok = db && r !== false;
    if (!ok) reply.status(503);
    return { status: ok ? "ok" : "degraded", db: db ? "up" : "down", ...(r === null ? {} : { redis: r ? "up" : "down" }) };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
