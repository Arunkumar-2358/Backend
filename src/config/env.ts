import { z } from "zod";

const optional = z.string().trim().min(1).optional();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  PII_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "PII_ENCRYPTION_KEY must be 64 hex characters"),

  UPLOAD_DIR: z.string().default("./storage"),
  NT_WEBHOOK_SECRET: optional,
  TELEPHONY_WEBHOOK_TOKEN: optional,
  CRON_SECRET: optional,
  ERROR_WEBHOOK_URL: z.string().url().optional(),

  MESSAGING_PROVIDER: z.string().default("mock"),
  WHATSAPP_TOKEN: optional,
  WHATSAPP_PHONE_NUMBER_ID: optional,
  MSG91_AUTH_KEY: optional,
  MSG91_SENDER_ID: optional,

  VAPID_PUBLIC_KEY: optional,
  VAPID_PRIVATE_KEY: optional,
  VAPID_SUBJECT: optional,

  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = load();
