/**
 * Contract-typed endpoints for NestJS controllers.
 *
 *   @Endpoint("GET /v1/tasks", { query: z.object({...}) })
 *   list({ actor, query }: Ctx<"GET /v1/tasks">) { return listOpenTasks(actor, query); }
 *
 * The key fixes the HTTP method, the path, the input schemas and the handler's
 * return type against contracts/ApiRoutes, so a controller cannot drift from
 * the contract the web client is compiled against. Inputs are validated with
 * zod before the handler runs (failures become 422 VALIDATION).
 *
 * `RawEndpoint` is the escape hatch for routes outside the JSON contract
 * (file downloads, Excel exports, provider webhooks): the handler receives the
 * Fastify reply and may send it itself; anything it returns is sent as JSON.
 */
import { Delete, Get, HttpCode, Patch, Post, Put, Res, SetMetadata, applyDecorators, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType, ZodTypeDef } from "zod";
import type { ApiRoutes } from "@contracts";
import type { Actor } from "@/lib/rbac";

export type RouteKey = keyof ApiRoutes & string;
type Part<K extends RouteKey, P extends string> = P extends keyof ApiRoutes[K] ? NonNullable<ApiRoutes[K][P]> : undefined;
type Schema<T> = ZodType<T, ZodTypeDef, unknown>;
export type UserActor = Extract<Actor, { kind: "user" }>;
export type Res<K extends RouteKey> = ApiRoutes[K]["response"];
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type AuthMode = "user" | "public";

export interface Ctx<K extends RouteKey, A = UserActor> {
  actor: A;
  params: Part<K, "params">;
  query: Part<K, "query">;
  body: Part<K, "body">;
  req: FastifyRequest;
  reply: FastifyReply;
}

/** Context for routes outside the typed contract. */
export interface RawCtx<A = UserActor | null> {
  actor: A;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  req: FastifyRequest;
  reply: FastifyReply;
}

interface Common {
  summary?: string;
  /** HTTP status on success (default 200; 201 is never implied). */
  status?: number;
  /** Tighter per-IP limit than the global default, e.g. login: { limit: 10, ttlMs: 60_000 }. */
  throttle?: { limit: number; ttlMs: number };
  /** Hide from the OpenAPI document (alias routes). */
  hidden?: boolean;
}

export type EndpointOptions<K extends RouteKey> = Common & {
  auth?: AuthMode;
  params?: Schema<Part<K, "params">>;
  query?: Schema<Part<K, "query">>;
  body?: Schema<Part<K, "body">>;
};

export type RawEndpointOptions = Common & {
  auth?: AuthMode;
  params?: ZodType;
  query?: ZodType;
  /** OpenAPI tag; defaults to the first path segment after /v1. */
  tag?: string;
};

/** Everything the guard, the param decorator and the OpenAPI builder need to know about a route. */
export interface EndpointMeta {
  method: Method;
  path: string;
  auth: AuthMode;
  tag?: string;
  summary?: string;
  status: number;
  hidden: boolean;
  raw: boolean;
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

export const ENDPOINT_META = "nt:endpoint";

/** Every endpoint declared at import time, in declaration order (read by the OpenAPI builder). */
export const endpointRegistry: EndpointMeta[] = [];

const METHOD_DECORATOR: Record<Method, (path?: string) => MethodDecorator> = { GET: Get, POST: Post, PUT: Put, PATCH: Patch, DELETE: Delete };

/** "/v1/leads/{id}/stage" → "/v1/leads/:id/stage" (Fastify / Nest path syntax). */
export const toRouterPath = (p: string) => p.replace(/\{(\w+)\}/g, ":$1").replace(/\{\*\}$/, "*");

const tagOf = (path: string) => path.split("/")[2];

/** Builds the handler's single context argument from the validated request. */
const EndpointContext = createParamDecorator((meta: EndpointMeta, ec: ExecutionContext) => {
  const http = ec.switchToHttp();
  const req = http.getRequest<FastifyRequest & { actor?: UserActor }>();
  const reply = http.getResponse<FastifyReply>();
  return {
    actor: req.actor ?? null,
    params: meta.params ? meta.params.parse(req.params ?? {}) : req.params,
    query: meta.query ? meta.query.parse(req.query ?? {}) : req.query,
    body: meta.body ? meta.body.parse(req.body) : req.body,
    req,
    reply,
  };
});

function declare(meta: EndpointMeta, extra: Array<MethodDecorator>) {
  endpointRegistry.push(meta);
  const decorators: Array<MethodDecorator> = [METHOD_DECORATOR[meta.method](toRouterPath(meta.path)), HttpCode(meta.status), SetMetadata(ENDPOINT_META, meta), ...extra];
  return (target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
    applyDecorators(...decorators)(target, key, descriptor);
    EndpointContext(meta)(target, key, 0);
  };
}

/** A JSON endpoint declared in contracts/ApiRoutes. See the file comment. */
export function Endpoint<K extends RouteKey>(key: K, opts: EndpointOptions<K> = {}) {
  const [method, path] = key.split(" ") as [Method, string];
  const meta: EndpointMeta = {
    method,
    path,
    auth: opts.auth ?? "user",
    tag: tagOf(path),
    summary: opts.summary,
    status: opts.status ?? 200,
    hidden: opts.hidden ?? false,
    raw: false,
    params: opts.params,
    query: opts.query,
    body: opts.body,
  };
  const extra = opts.throttle ? [Throttle({ default: { limit: opts.throttle.limit, ttl: opts.throttle.ttlMs } })] : [];
  const apply = declare(meta, extra);
  // The descriptor type ties the method's return type to the contract.
  return <T extends (ctx: Ctx<K, never>) => Promise<Res<K>>>(target: object, prop: string | symbol, descriptor: TypedPropertyDescriptor<T>) => {
    apply(target, prop, descriptor as PropertyDescriptor);
  };
}

/**
 * A route outside the JSON contract. The handler may send the reply itself
 * (downloads) or return a value, which is sent as JSON with `status`.
 * One method per handler: give GET/POST aliases their own (hidden) method.
 */
export function RawEndpoint(method: Method, path: string, opts: RawEndpointOptions = {}) {
  const meta: EndpointMeta = {
    method,
    path,
    auth: opts.auth ?? "user",
    tag: opts.tag ?? tagOf(path),
    summary: opts.summary,
    status: opts.status ?? 200,
    hidden: opts.hidden ?? false,
    raw: true,
    params: opts.params,
    query: opts.query,
  };
  endpointRegistry.push(meta);
  const extra = opts.throttle ? [Throttle({ default: { limit: opts.throttle.limit, ttl: opts.throttle.ttlMs } })] : [];
  return (target: object, prop: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (ctx: RawCtx) => Promise<unknown>;
    descriptor.value = async function (this: unknown, ctx: RawCtx) {
      const result = await original.call(this, ctx);
      // HttpCode below sets meta.status before the handler runs; the handler may still override it (e.g. 503).
      if (!ctx.reply.sent) await ctx.reply.send(result);
    };
    // Applied after replacing descriptor.value so the metadata lands on the function Nest actually calls.
    applyDecorators(METHOD_DECORATOR[method](toRouterPath(path)), HttpCode(meta.status), SetMetadata(ENDPOINT_META, meta), ...extra)(target, prop, descriptor);
    EndpointContext(meta)(target, prop, 0);
    // @Res() tells Nest the handler owns the reply (the wrapper above always sends it).
    Res()(target, prop, 1);
  };
}
