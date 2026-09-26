import { Redis, type RedisOptions } from "ioredis";
import { env } from "@/config/env";

/**
 * A Redis connection for BullMQ / the rate-limit store. BullMQ workers need
 * `maxRetriesPerRequest: null` so blocking commands survive reconnects.
 */
export function redisConnection(opts: RedisOptions = {}): Redis {
  if (!env.REDIS_URL) throw new Error("REDIS_URL is not configured");
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false, ...opts });
}

export const redisEnabled = () => !!env.REDIS_URL;
