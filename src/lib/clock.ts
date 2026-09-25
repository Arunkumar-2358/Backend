/**
 * Injectable clock. All business logic reads time through `now()` so tests can
 * use a fake clock (setClock / advanceClock) — e.g. to fire the 60-day check-in.
 */
let override: Date | null = null;

export function now(): Date {
  return override ? new Date(override) : new Date();
}

export function setClock(d: Date | string | null) {
  override = d === null ? null : new Date(d);
}

export function advanceClock(ms: number) {
  override = new Date(now().getTime() + ms);
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
