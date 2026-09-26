import "./instrument";
import { buildApp } from "@/app";
import { env } from "@/config/env";
import { prisma } from "@/lib/db";

const app = await buildApp({
  logger: {
    level: env.LOG_LEVEL,
    redact: ["req.headers.authorization", "req.headers.cookie", "req.body.password", "req.body.refreshToken"],
    transport: env.NODE_ENV === "development" ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } : undefined,
  },
});

const shutdown = async (signal: string) => {
  app.getHttpAdapter().getInstance().log.info({ signal }, "shutting down");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void shutdown(sig));

await app.listen({ host: env.HOST, port: env.PORT });
