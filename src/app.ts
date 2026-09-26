import "reflect-metadata";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
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

/** "2" → trust the nearest 2 hops; otherwise proxy-addr names/CIDRs ("loopback,10.0.0.0/8"). */
function trustProxySetting(v: string): string[] | ((addr: string, hop: number) => boolean) {
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_addr, hop) => hop < hops;
  }
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

/** Form fields; repeated keys become arrays (same shape as @fastify/formbody). */
function parseForm(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  for (const [k, v] of new URLSearchParams(text)) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

/**
 * JSON, forms and a text catch-all, each keeping `req.rawBody` so webhook HMACs
 * are verified over the exact bytes. JSON uses Fastify's hardened parser
 * (rejects __proto__ / constructor poisoning); an empty JSON body is treated as
 * no body rather than an error, because some IVR providers send exactly that.
 */
function registerBodyParsers(app: FastifyInstance) {
  const json = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body: Buffer, done) => {
    (req as RawBodyRequest).rawBody = body;
    if (body.length === 0) return done(null, undefined);
    json(req, body.toString("utf8"), done);
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer" }, (req, body: Buffer, done) => {
    (req as RawBodyRequest).rawBody = body;
    done(null, parseForm(body.toString("utf8")));
  });
  // IVR providers are loose about content types: accept anything else as text.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (req, body: Buffer, done) => {
    (req as RawBodyRequest).rawBody = body;
    done(null, body.toString("utf8"));
  });
}

export type BuildOptions = { logger?: FastifyServerOptions["logger"]; docs?: boolean; nestLogLevels?: LogLevel[] | false };

/** The NestJS application on Fastify. Tests call `.getHttpAdapter().getInstance().inject()`. */
export async function buildApp(opts: BuildOptions = {}): Promise<NestFastifyApplication> {
  const fastify = Fastify({
    logger: opts.logger ?? false,
    genReqId: (req) => {
      const given = req.headers["x-request-id"];
      return typeof given === "string" && /^[\w.-]{1,100}$/.test(given) ? given : randomUUID();
    },
    // false: genReqId (above) validates the caller's x-request-id instead of Fastify trusting it verbatim.
    requestIdHeader: false,
    trustProxy: trustProxySetting(env.TRUST_PROXY),
    bodyLimit: MAX_UPLOAD_BYTES,
  });
  fastify.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  observeHttp(fastify);
  registerBodyParsers(fastify);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(fastify as never), {
    // Body parsing is ours (registerBodyParsers): exact bytes kept for webhook signatures.
    bodyParser: false,
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
