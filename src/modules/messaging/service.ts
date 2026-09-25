import type { Channel } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { type Actor, actorId } from "@/lib/rbac";
import { getSetting } from "@/lib/settings";
import { maskMobile } from "@contracts/shared/phone";
import { ValidationError } from "@/lib/errors";
import { decryptCandidate } from "@/modules/candidates/service";
import { adapterFor } from "./adapters";

export function renderTemplate(body: string, vars: Record<string, string | number | null | undefined>) {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ""));
}

export async function enrolmentLink(candidateCode: string, db: Tx = prisma) {
  const tpl = await getSetting("enrolmentLinkTemplate", db);
  return renderTemplate(tpl, { code: candidateCode });
}

/**
 * Send a templated message to a lead through the channel's adapter and record it.
 * Templates are looked up by `${key}` and must match the channel.
 */
export async function sendTemplate(
  actor: Actor,
  candidateId: string,
  templateKey: string,
  channel: Channel,
  extraVars: Record<string, string | number | null | undefined> = {},
  db: Tx = prisma,
) {
  const tpl = await db.messageTemplate.findFirst({ where: { key: templateKey, active: true } });
  if (!tpl) throw new ValidationError(`Message template "${templateKey}" not found`);
  const c = decryptCandidate(await db.candidate.findUniqueOrThrow({ where: { id: candidateId } }));
  const to = channel === "EMAIL" ? c.email : c.mobile;
  if (!to) throw new ValidationError(`Candidate has no ${channel === "EMAIL" ? "email" : "mobile"}`);
  const vars = { name: c.name, code: c.candidateCode, link: await enrolmentLink(c.candidateCode, db), ...extraVars };
  const body = renderTemplate(tpl.body, vars);
  const subject = tpl.subject ? renderTemplate(tpl.subject, vars) : null;
  const adapter = adapterFor(channel);
  const masked = channel === "EMAIL" ? to.replace(/^(.).*(@.*)$/, "$1•••$2") : maskMobile(to);
  const msg = await db.message.create({
    data: { candidateId, channel, toAddress: masked, templateKey, subject, body, provider: adapter.name, status: "QUEUED", sentById: actorId(actor) },
  });
  try {
    const r = await adapter.send({ channel, to, subject, body });
    await db.message.update({ where: { id: msg.id }, data: { status: "SENT", providerRef: r.providerRef } });
  } catch (e) {
    await db.message.update({ where: { id: msg.id }, data: { status: "FAILED", error: String(e) } });
    throw e;
  }
  await audit(actor, "MESSAGE_SENT", "candidate", candidateId, { channel, templateKey, messageId: msg.id }, db);
  return msg;
}
