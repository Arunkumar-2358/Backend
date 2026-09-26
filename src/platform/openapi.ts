import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType } from "zod";
import { endpointRegistry, type EndpointMeta } from "./endpoint";

type JsonSchema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

const toSchema = (z: ZodType): JsonSchema => {
  const s = zodToJsonSchema(z, { target: "openApi3", $refStrategy: "none" }) as JsonSchema;
  delete s.$schema;
  return s;
};

function parameters(meta: EndpointMeta) {
  const out: object[] = [];
  const add = (where: "path" | "query", z?: ZodType) => {
    if (!z) return;
    const s = toSchema(z);
    for (const [name, schema] of Object.entries(s.properties ?? {})) {
      out.push({ name, in: where, required: where === "path" || (s.required ?? []).includes(name), schema });
    }
  };
  add("path", meta.params);
  add("query", meta.query);
  // Path params without a schema still need declaring.
  for (const m of meta.path.matchAll(/\{(\w+)\}/g)) {
    if (!out.some((p) => (p as { name: string; in: string }).name === m[1] && (p as { in: string }).in === "path")) out.push({ name: m[1], in: "path", required: true, schema: { type: "string" } });
  }
  return out;
}

/** OpenAPI 3 document built from every @Endpoint / @RawEndpoint declaration. */
export function buildOpenApi() {
  const paths: Record<string, Record<string, object>> = {};
  const sorted = [...endpointRegistry].filter((m) => !m.hidden).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  for (const meta of sorted) {
    const op: Record<string, unknown> = {
      tags: meta.tag ? [meta.tag] : undefined,
      summary: meta.summary,
      parameters: parameters(meta),
      responses: { [String(meta.status)]: { description: "OK" } },
    };
    if (meta.auth === "public") op.security = [];
    if (meta.body) op.requestBody = { required: true, content: { "application/json": { schema: toSchema(meta.body) } } };
    (paths[meta.path] ??= {})[meta.method.toLowerCase()] = JSON.parse(JSON.stringify(op));
  }
  return {
    openapi: "3.0.3",
    info: { title: "Nextenti Recruit CRM API", version: "2.0.0", description: "Backend API for the Nextenti Recruit CRM web app and integrations." },
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        cookie: { type: "apiKey", in: "cookie", name: "nt_session" },
      },
    },
    security: [{ bearer: [] }, { cookie: [] }],
    paths,
  };
}
