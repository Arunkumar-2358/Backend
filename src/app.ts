import Fastify, { type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { env } from "@/config/env";
import { registerErrorHandling } from "@/plugins/errors";
import { registerDocs } from "@/plugins/docs";
import { prisma } from "@/lib/db";
import { modules } from "@/modules";

export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

export async function buildApp(opts: { logger?: FastifyServerOptions["logger"]; docs?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? false,
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
    requestIdHeader: "x-request-id",
    trustProxy: true,
    bodyLimit: MAX_UPLOAD_BYTES,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.CORS_ORIGINS.split(",").map((o) => o.trim()), credentials: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 } });
  await app.register(rateLimit, { global: false });
  await registerDocs(app, { ui: opts.docs ?? env.NODE_ENV !== "production" });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.get("/health", { schema: { hide: true } }, async () => ({ status: "ok" }));
  app.get("/health/ready", { schema: { hide: true } }, async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ok", db: "up" };
    } catch {
      return reply.status(503).send({ status: "degraded", db: "down" });
    }
  });

  for (const register of modules) await register(app);
  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
