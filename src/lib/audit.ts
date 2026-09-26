import { prisma, type Tx } from "./db";
import type { Actor } from "./rbac";
import { now } from "./clock";

export type AuditAction =
  | "STAGE_CHANGE"
  | "FIELD_EDIT"
  | "CREATE"
  | "REASSIGN"
  | "VIEW_PII"
  | "LOGIN"
  | "LOGIN_FAILED"
  | "REFRESH_REUSE"
  | "IMPORT"
  | "CONTACT_LOGGED"
  | "MESSAGE_SENT"
  | "REMINDER_SENT"
  | "TASK_CREATED"
  | "TASK_COMPLETED"
  | "JOB_RUN"
  | "RED_FLAG"
  | "SETTING_CHANGE"
  | "DATA_DELETION"
  | "EXPORT";

export async function audit(
  actor: Actor,
  action: AuditAction,
  entityType: string,
  entityId: string,
  diff?: unknown,
  db: Tx = prisma,
) {
  await db.auditLog.create({
    data: {
      at: now(),
      actorId: actor.kind === "user" ? actor.id : null,
      actorLabel: actor.kind === "user" ? actor.name : `system:${actor.label}`,
      action,
      entityType,
      entityId,
      diff: diff === undefined ? undefined : (JSON.parse(JSON.stringify(diff)) as object),
    },
  });
}

/** Field-level diff for FIELD_EDIT audit rows. */
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    const a = JSON.stringify(before[k] ?? null);
    const b = JSON.stringify(after[k] ?? null);
    if (a !== b) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return out;
}
