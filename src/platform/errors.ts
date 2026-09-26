import { Catch, HttpException, NotFoundException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import * as Sentry from "@sentry/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiErrorBody, ApiErrorCode } from "@contracts";
import { GateError, ValidationError } from "@/lib/errors";
import { HttpError, UnauthorizedError } from "@/lib/http-errors";
import { ForbiddenError } from "@/lib/rbac";
import { env } from "@/config/env";

type Classified = { status: number; code: ApiErrorCode; message: string; failures?: string[] };

const CODE_BY_STATUS: Record<number, ApiErrorCode> = { 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 429: "RATE_LIMITED" };

export function classify(e: unknown, req: FastifyRequest): Classified {
  if (e instanceof HttpError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof UnauthorizedError) return { status: 401, code: "UNAUTHORIZED", message: e.message };
  if (e instanceof ForbiddenError) return { status: 403, code: "FORBIDDEN", message: e.message };
  if (e instanceof GateError) return { status: 422, code: "GATE", message: e.message, failures: e.failures };
  if (e instanceof ValidationError) return { status: 422, code: "VALIDATION", message: e.message };
  if (e instanceof ZodError) {
    const first = e.issues[0];
    const field = first?.path.join(".");
    return { status: 422, code: "VALIDATION", message: field ? `${field}: ${first?.message}` : (first?.message ?? "Invalid request") };
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2025") return { status: 404, code: "NOT_FOUND", message: "Record not found" };
    if (e.code === "P2002") return { status: 409, code: "CONFLICT", message: "That record already exists" };
  }
  if (e instanceof ThrottlerException) return { status: 429, code: "RATE_LIMITED", message: "Too many requests, try again shortly" };
  if (e instanceof NotFoundException) return { status: 404, code: "NOT_FOUND", message: `No route for ${req.method} ${req.url.split("?")[0]}` };
  if (e instanceof HttpException) {
    const status = e.getStatus();
    if (status < 500) return { status, code: CODE_BY_STATUS[status] ?? "VALIDATION", message: e.message };
  }
  // Fastify's own errors (bad JSON, payload too large, unsupported media type…).
  const fe = e as { statusCode?: number; message?: string };
  if (fe.statusCode === 429) return { status: 429, code: "RATE_LIMITED", message: "Too many requests, try again shortly" };
  if (fe.statusCode && fe.statusCode < 500) return { status: fe.statusCode, code: CODE_BY_STATUS[fe.statusCode] ?? "VALIDATION", message: fe.message ?? "Invalid request" };
  return { status: 500, code: "INTERNAL", message: "Something went wrong. Please try again." };
}

function report(err: unknown, req: FastifyRequest) {
  const e = err instanceof Error ? err : new Error(String(err));
  req.log.error({ err: e }, "unhandled error");
  if (env.SENTRY_DSN) Sentry.captureException(e, { tags: { requestId: req.id }, extra: { method: req.method, path: req.url.split("?")[0] } });
  if (env.ERROR_WEBHOOK_URL) {
    fetch(env.ERROR_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `CRM API error on ${req.method} ${req.url.split("?")[0]}: ${e.message}`,
        at: new Date().toISOString(),
        message: e.message,
        stack: e.stack?.split("\n").slice(0, 8).join("\n"),
        method: req.method,
        path: req.url.split("?")[0],
        requestId: req.id,
      }),
    }).catch(() => {});
  }
}

/** One error envelope for every failure: { error: { code, message, failures?, requestId } }. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const c = classify(err, req);
    if (c.status >= 500) report(err, req);
    const body: ApiErrorBody = { error: { code: c.code, message: c.message, failures: c.failures, requestId: req.id } };
    if (c.status === 401) reply.header("www-authenticate", 'Bearer realm="nextenti"');
    void reply.status(c.status).send(body);
  }
}
