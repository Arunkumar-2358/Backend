import type { Unit } from "@contracts/shared/kpi";
import { ValidationError } from "@/lib/errors";
import { ForbiddenError, isAdmin, type Actor } from "@/lib/rbac";

/** Every Admin endpoint: the admin role is required (the web's admin layout/guard rule). */
export function requireAdmin(actor: Actor, msg = "Only an admin can change this") {
  if (!isAdmin(actor)) throw new ForbiddenError(msg);
}

/** Attendance / holiday dates are stored as UTC midnight of the IST calendar day. */
export function utcDay(key: string, msg = `Invalid date ${key}`) {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new ValidationError(msg);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

/** Ratio metrics are not targeted; everything else can be. */
export const TARGETABLE_UNITS: Unit[] = ["pct", "count", "minutes", "avg"];
