import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

export async function registerDocs(app: FastifyInstance, { ui }: { ui: boolean }) {
  await app.register(swagger, {
    openapi: {
      info: { title: "Nextenti Recruit CRM API", version: "1.0.0", description: "Backend API for the Nextenti Recruit CRM web app and integrations." },
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          cookie: { type: "apiKey", in: "cookie", name: "nt_session" },
        },
      },
      security: [{ bearer: [] }, { cookie: [] }],
    },
    transform: jsonSchemaTransform,
  });
  if (ui) await app.register(swaggerUi, { routePrefix: "/docs" });
}
