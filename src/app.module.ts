import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import { env } from "@/config/env";
import { redisConnection } from "@/platform/redis";
import { ApiAuthGuard, ApiThrottlerGuard } from "@/platform/guards";
import { domainModules } from "@/modules";

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: "default", ttl: 60_000, limit: env.RATE_LIMIT_PER_MINUTE }],
      // Shared counters across API replicas; in-memory when Redis is not configured (dev/test).
      // Tests stay in-memory so counters never leak between test files through a shared Redis.
      storage: env.REDIS_URL && env.NODE_ENV !== "test" ? new ThrottlerStorageRedisService(
              // Fail fast: a Redis outage must not make every request (login, health, webhooks) hang.
              redisConnection({ keyPrefix: `${env.QUEUE_PREFIX}:throttle:`, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000 }),
            ) : undefined,
    }),
    ...domainModules,
  ],
  providers: [
    // Order matters: rate-limit before touching the database for auth.
    { provide: APP_GUARD, useClass: ApiThrottlerGuard },
    { provide: APP_GUARD, useClass: ApiAuthGuard },
  ],
})
export class AppModule {}
