import { Controller, Module } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/config/env";
import { SYSTEM } from "@/lib/rbac";
import { fromIstInputValue } from "@contracts/shared/dates";
import { ValidationError } from "@/lib/errors";
import { RawEndpoint, type RawCtx } from "@/platform/endpoint";
import { logMissedCall, handleNtEnrolment, type NtEnrolmentEvent } from "@/modules/outreach/service";
import { ensureRecurringJobs, runDueJobs } from "@/modules/jobs/runner";

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function validSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const given = header.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), createHmac("sha256", secret).update(raw).digest());
}

/** Exotel sends "YYYY-MM-DD HH:MM:SS" in IST with no zone; anything else is parsed as ISO. */
function parseStartTime(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const v = s.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(v)) return fromIstInputValue(v.replace(" ", "T")) ?? undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

const fail = (reply: FastifyReply, status: number, message: string) => reply.status(status).send({ ok: false, error: message });

const isForm = (req: FastifyRequest) => /^application\/x-www-form-urlencoded\b/i.test(req.headers["content-type"] ?? "");

/**
 * The exact request bytes. JSON (and form) bodies are parsed by Nest, which keeps the
 * original bytes on req.rawBody; any other content type arrives as a string body.
 * Form bodies are not raw text for these hooks (they were parsed into fields before), so they yield nothing.
 */
function rawBytes(req: FastifyRequest): Buffer {
  if (isForm(req)) return Buffer.alloc(0);
  const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  return typeof req.body === "string" ? Buffer.from(req.body, "utf8") : Buffer.alloc(0);
}

async function missedCall(req: FastifyRequest, reply: FastifyReply) {
  if (!env.TELEPHONY_WEBHOOK_TOKEN) return fail(reply, 503, "Telephony webhook not configured");
  const q = req.query as Record<string, string>;
  if (!safeEqual(q.token ?? "", env.TELEPHONY_WEBHOOK_TOKEN)) return fail(reply, 401, "Invalid token");

  const p: Record<string, string> = { ...q };
  const raw = rawBytes(req).toString("utf8");
  if (raw) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(raw) ?? {})) if (v !== null && v !== undefined) p[k] = String(v);
    } catch {
      /* fall through with the query-string values */
    }
  } else if (req.body && typeof req.body === "object") {
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) if (typeof v === "string") p[k] = v;
  }

  const from = p.From ?? p.from ?? p.CallFrom;
  if (!from) return fail(reply, 400, "Missing caller number (From / CallFrom)");
  const sid = p.CallSid ?? p.callSid;
  try {
    const mc = await logMissedCall(SYSTEM("telephony"), {
      mobile: from,
      receivedAt: parseStartTime(p.StartTime ?? p.startTime),
      notes: sid ? `Telephony call ${sid}` : "Logged by telephony",
    });
    return { ok: true, id: mc.id, matchedLead: !!mc.candidateId };
  } catch (e) {
    if (e instanceof ValidationError) return fail(reply, 400, e.message);
    throw e;
  }
}

async function runJobs(req: FastifyRequest, reply: FastifyReply) {
  if (!env.CRON_SECRET) return fail(reply, 503, "Cron not configured");
  const given = (req.headers["x-cron-secret"] as string | undefined) ?? req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  if (!safeEqual(given, env.CRON_SECRET)) return fail(reply, 401, "Unauthorised");
  const started = Date.now();
  await ensureRecurringJobs();
  const results = await runDueJobs();
  return { ok: true, ran: results.length, failed: results.filter((r) => r.result.startsWith("error:")).length, ms: Date.now() - started, results };
}

const TELEPHONY = "Telephony/IVR missed-call hook (?token=TELEPHONY_WEBHOOK_TOKEN)";
const CRON = "Run due scheduled jobs (x-cron-secret or Bearer CRON_SECRET)";

/** Machine-to-machine endpoints: telephony (Exotel-style), NT platform webhook, scheduled-job trigger. */
@Controller()
export class IntegrationsController {
  @RawEndpoint("POST", "/v1/telephony/missed-call", { auth: "public", tag: "integrations", summary: TELEPHONY })
  async missedCallPost({ req, reply }: RawCtx<null>) {
    return missedCall(req, reply);
  }

  // Some providers (e.g. Exotel Passthru) can only issue GET requests.
  @RawEndpoint("GET", "/v1/telephony/missed-call", { auth: "public", tag: "integrations", summary: TELEPHONY, hidden: true })
  async missedCallGet({ req, reply }: RawCtx<null>) {
    return missedCall(req, reply);
  }

  @RawEndpoint("POST", "/v1/webhooks/nt-enrolment", { auth: "public", tag: "integrations", summary: "NT platform enrolment webhook (x-nt-signature: HMAC-SHA256 of body)" })
  async ntEnrolment({ req, reply }: RawCtx<null>) {
    if (!env.NT_WEBHOOK_SECRET) return fail(reply, 503, "Webhook not configured");
    const raw = rawBytes(req);
    if (!validSignature(raw, req.headers["x-nt-signature"] as string | undefined, env.NT_WEBHOOK_SECRET)) return fail(reply, 401, "Invalid signature");
    let evt: NtEnrolmentEvent;
    try {
      evt = JSON.parse(raw.toString("utf8"));
    } catch {
      return fail(reply, 400, "Body must be JSON");
    }
    if (!evt || typeof evt !== "object" || typeof evt.mobile !== "string") return fail(reply, 400, "`mobile` (string) is required");
    if (evt.registeredAt && isNaN(new Date(evt.registeredAt).getTime())) return fail(reply, 400, "`registeredAt` must be an ISO date");
    try {
      return { ok: true, ...(await handleNtEnrolment(evt)) };
    } catch (e) {
      if (e instanceof ValidationError) return fail(reply, 400, e.message);
      throw e;
    }
  }

  @RawEndpoint("POST", "/v1/cron/run-jobs", { auth: "public", tag: "integrations", summary: CRON })
  async runJobsPost({ req, reply }: RawCtx<null>) {
    return runJobs(req, reply);
  }

  @RawEndpoint("GET", "/v1/cron/run-jobs", { auth: "public", tag: "integrations", summary: CRON, hidden: true })
  async runJobsGet({ req, reply }: RawCtx<null>) {
    return runJobs(req, reply);
  }
}

@Module({ controllers: [IntegrationsController] })
export class IntegrationsModule {}
