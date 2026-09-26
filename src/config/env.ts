import { z } from "zod";

const optional = z.string().trim().min(1).optional();
const flag = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    CORS_ORIGINS: z.string().default("http://localhost:3000"),

    DATABASE_URL: z.string().url(),
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    PII_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "PII_ENCRYPTION_KEY must be 64 hex characters"),

    /** Access tokens are short-lived; the refresh token (rotated on every use) keeps the user signed in. */
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_IDLE_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    REFRESH_TOKEN_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    /** Redis backs BullMQ (scheduled automation) and the shared rate-limit store. Required in production. */
    REDIS_URL: z.string().url().optional(),
    QUEUE_PREFIX: z.string().default("nt"),
    /** Global per-IP ceiling for every route; sensitive routes set their own tighter limits. */
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),

    /** Object storage: "local" (dev/test) or "s3" (AWS S3 / MinIO). */
    STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    UPLOAD_DIR: z.string().default("./storage"),
    S3_BUCKET: optional,
    S3_REGION: z.string().default("ap-south-1"),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: optional,
    S3_SECRET_ACCESS_KEY: optional,
    S3_FORCE_PATH_STYLE: flag.optional(),

    /** ClamAV daemon for malware scanning on upload. When set, uploads fail closed if it cannot be reached. */
    CLAMAV_HOST: optional,
    CLAMAV_PORT: z.coerce.number().int().positive().default(3310),

    NT_WEBHOOK_SECRET: optional,
    TELEPHONY_WEBHOOK_TOKEN: optional,
    CRON_SECRET: optional,
    ERROR_WEBHOOK_URL: z.string().url().optional(),

    SENTRY_DSN: z.string().url().optional(),
    SENTRY_ENVIRONMENT: optional,
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
    /** Bearer token for GET /metrics (Prometheus). The endpoint is disabled when unset. */
    METRICS_TOKEN: z.string().min(16).optional(),

    MESSAGING_PROVIDER: z.string().default("mock"),
    WHATSAPP_TOKEN: optional,
    WHATSAPP_PHONE_NUMBER_ID: optional,
    MSG91_AUTH_KEY: optional,
    MSG91_SENDER_ID: optional,
    POSTMARK_SERVER_TOKEN: optional,
    EMAIL_FROM: optional,

    VAPID_PUBLIC_KEY: optional,
    VAPID_PRIVATE_KEY: optional,
    VAPID_SUBJECT: optional,

    WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV !== "production") return;
    const need = (key: keyof typeof e, why: string) => {
      if (!e[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `required in production (${why})` });
    };
    need("REDIS_URL", "scheduled automation and rate limiting");
    if (e.STORAGE_DRIVER !== "s3") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["STORAGE_DRIVER"], message: "must be s3 in production (local disk breaks with more than one replica)" });
    if (e.STORAGE_DRIVER === "s3") need("S3_BUCKET", "object storage");
    if (e.SESSION_SECRET.startsWith("dev-") || e.SESSION_SECRET.includes("change-me")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SESSION_SECRET"], message: "looks like a development placeholder" });
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
