import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/config/env";
import { SYSTEM } from "@/lib/rbac";
import { fromIstInputValue } from "@contracts/shared/dates";
import { ValidationError } from "@/lib/errors";
import { logMissedCall, handleNtEnrolment, type NtEnrolmentEvent } from "@/modules/outreach/service";
import { ensureRecurringJobs, runDueJobs } from "@/modules/jobs/runner";

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function validSignature(raw: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const given = header.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), createHmac("sha256", secret).update(raw, "utf8").digest());
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

/** Machine-to-machine endpoints: telephony (Exotel-style), NT platform webhook, scheduled-job trigger. */
export async function integrationRoutes(app: FastifyInstance) {
  await app.register(async (scope) => {
    await scope.register(formbody);
    // Keep the raw JSON text so webhook signatures can be verified byte-for-byte.
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    // IVR providers are loose about content types; accept anything and read what we can.
    scope.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

    const missedCall = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!env.TELEPHONY_WEBHOOK_TOKEN) return fail(reply, 503, "Telephony webhook not configured");
      const q = req.query as Record<string, string>;
      if (!safeEqual(q.token ?? "", env.TELEPHONY_WEBHOOK_TOKEN)) return fail(reply, 401, "Invalid token");

      const p: Record<string, string> = { ...q };
      if (typeof req.body === "string" && req.body) {
        try {
          for (const [k, v] of Object.entries(JSON.parse(req.body) ?? {})) if (v !== null && v !== undefined) p[k] = String(v);
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
    };
    const telephonySchema = { tags: ["integrations"], summary: "Telephony/IVR missed-call hook (?token=TELEPHONY_WEBHOOK_TOKEN)", security: [] };
    scope.post("/v1/telephony/missed-call", { schema: telephonySchema }, missedCall);
    // Some providers (e.g. Exotel Passthru) can only issue GET requests.
    scope.get("/v1/telephony/missed-call", { schema: { ...telephonySchema, hide: true } }, missedCall);

    scope.post(
      "/v1/webhooks/nt-enrolment",
      { schema: { tags: ["integrations"], summary: "NT platform enrolment webhook (x-nt-signature: HMAC-SHA256 of body)", security: [] } },
      async (req, reply) => {
        if (!env.NT_WEBHOOK_SECRET) return fail(reply, 503, "Webhook not configured");
        const raw = typeof req.body === "string" ? req.body : "";
        if (!validSignature(raw, req.headers["x-nt-signature"] as string | undefined, env.NT_WEBHOOK_SECRET)) return fail(reply, 401, "Invalid signature");
        let evt: NtEnrolmentEvent;
        try {
          evt = JSON.parse(raw);
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
      },
    );

    const runJobs = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!env.CRON_SECRET) return fail(reply, 503, "Cron not configured");
      const given = (req.headers["x-cron-secret"] as string | undefined) ?? req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
      if (!safeEqual(given, env.CRON_SECRET)) return fail(reply, 401, "Unauthorised");
      const started = Date.now();
      await ensureRecurringJobs();
      const results = await runDueJobs();
      return { ok: true, ran: results.length, failed: results.filter((r) => r.result.startsWith("error:")).length, ms: Date.now() - started, results };
    };
    const cronSchema = { tags: ["integrations"], summary: "Run due scheduled jobs (x-cron-secret or Bearer CRON_SECRET)", security: [] };
    scope.post("/v1/cron/run-jobs", { schema: cronSchema }, runJobs);
    scope.get("/v1/cron/run-jobs", { schema: { ...cronSchema, hide: true } }, runJobs);
  });
}
