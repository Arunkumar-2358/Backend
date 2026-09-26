import "reflect-metadata";
import Fastify, { type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import type { LogLevel } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { env } from "@/config/env";
import { AppModule } from "@/app.module";
import { ApiExceptionFilter } from "@/platform/errors";
import { buildOpenApi } from "@/platform/openapi";
import { observeHttp } from "@/platform/metrics";

export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

export type BuildOptions = { logger?: FastifyServerOptions["logger"]; docs?: boolean; nestLogLevels?: LogLevel[] | false };

/** The NestJS application on Fastify. Tests call `.getHttpAdapter().getInstance().inject()`. */
export async function buildApp(opts: BuildOptions = {}): Promise<NestFastifyApplication> {
  const fastify = Fastify({
    logger: opts.logger ?? false,
    genReqId: (req) => {
      const given = req.headers["x-request-id"];
      return typeof given === "string" && /^[\w.-]{1,100}$/.test(given) ? given : randomUUID();
    },
    requestIdHeader: "x-request-id",
    trustProxy: true,
    bodyLimit: MAX_UPLOAD_BYTES,
  });
  fastify.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  observeHttp(fastify);
  // IVR providers are loose about content types: accept anything as text (JSON and forms are parsed by Nest).
  fastify.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(fastify as never), {
    // rawBody keeps the exact bytes for webhook signature checks (req.rawBody).
    rawBody: true,
    logger: opts.nestLogLevels ?? (env.NODE_ENV === "test" ? false : ["error", "warn", "log"]),
    abortOnError: false,
  });
  await app.register(helmet as never, { contentSecurityPolicy: false });
  await app.register(cookie as never);
  await app.register(multipart as never, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 } });
  app.enableCors({ origin: env.CORS_ORIGINS.split(",").map((o) => o.trim()), credentials: true });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  if (opts.docs ?? env.NODE_ENV !== "production") SwaggerModule.setup("docs", app, buildOpenApi() as unknown as OpenAPIObject);

  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export type App = NestFastifyApplication;
