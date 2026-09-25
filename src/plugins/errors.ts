import type { FastifyError, FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import type { ApiErrorBody, ApiErrorCode } from "@contracts";
import { GateError, ValidationError } from "@/lib/errors";
import { ForbiddenError } from "@/lib/rbac";
import { UnauthorizedError } from "./auth";
import { env } from "@/config/env";

/** An error that maps straight to an HTTP status, for cases the domain errors do not cover. */
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: ApiErrorCode, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
export const notFound = (message = "Not found") => new HttpError(404, "NOT_FOUND", message);

function classify(e: unknown): { status: number; code: ApiErrorCode; message: string; failures?: string[] } {
  if (e instanceof HttpError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof UnauthorizedError) return { status: 401, code: "UNAUTHORIZED", message: e.message };
  if (e instanceof ForbiddenError) return { status: 403, code: "FORBIDDEN", message: e.message };
  if (e instanceof GateError) return { status: 422, code: "GATE", message: e.message, failures: e.failures };
  if (e instanceof ValidationError) return { status: 422, code: "VALIDATION", message: e.message };
  if (hasZodFastifySchemaValidationErrors(e)) {
    const first = e.validation[0];
    const field = first?.instancePath?.replace(/^\//, "").replace(/\//g, ".");
    return { status: 422, code: "VALIDATION", message: field ? `${field}: ${first?.message}` : (first?.message ?? "Invalid request") };
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2025") return { status: 404, code: "NOT_FOUND", message: "Record not found" };
    if (e.code === "P2002") return { status: 409, code: "CONFLICT", message: "That record already exists" };
  }
  const fe = e as FastifyError;
  if (fe.statusCode === 429) return { status: 429, code: "RATE_LIMITED", message: "Too many requests, try again shortly" };
  if (fe.statusCode && fe.statusCode < 500) return { status: fe.statusCode, code: fe.statusCode === 404 ? "NOT_FOUND" : "VALIDATION", message: fe.message };
  return { status: 500, code: "INTERNAL", message: "Something went wrong. Please try again." };
}

export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler(async (err: FastifyError, req, reply) => {
    const c = classify(err);
    if (c.status >= 500) {
      req.log.error({ err }, "unhandled error");
      if (env.ERROR_WEBHOOK_URL) {
        fetch(env.ERROR_WEBHOOK_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: `CRM API error on ${req.method} ${req.url}: ${err.message}`,
            at: new Date().toISOString(),
            message: err.message,
            stack: err.stack?.split("\n").slice(0, 8).join("\n"),
            method: req.method,
            path: req.url,
            requestId: req.id,
          }),
        }).catch(() => {});
      }
    }
    const body: ApiErrorBody = { error: { code: c.code, message: c.message, failures: c.failures, requestId: req.id } };
    return reply.status(c.status).send(body);
  });

  app.setNotFoundHandler(async (req, reply) => {
    const body: ApiErrorBody = { error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.url.split("?")[0]}`, requestId: req.id } };
    return reply.status(404).send(body);
  });
}
