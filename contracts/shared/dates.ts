/**
 * Indian locale helpers: IST (UTC+05:30, no DST), DD-MM-YYYY display,
 * Monday–Sunday weeks, calendar months, and working days with a holiday calendar.
 */
export const IST_OFFSET_MS = 330 * 60_000;

/** Shift a UTC instant to a Date whose UTC fields read as IST wall time. */
function toIstWall(d: Date): Date {
  return new Date(d.getTime() + IST_OFFSET_MS);
}
function fromIstWall(d: Date): Date {
  return new Date(d.getTime() - IST_OFFSET_MS);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const w = toIstWall(new Date(d));
  return `${pad(w.getUTCDate())}-${pad(w.getUTCMonth() + 1)}-${w.getUTCFullYear()}`;
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  const w = toIstWall(new Date(d));
  return `${formatDate(d)} ${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
}

/** Hour of day (0–23) in IST. */
export function istHour(d: Date): number {
  return toIstWall(d).getUTCHours();
}

/** Midnight IST (as a UTC instant) of the day containing d. */
export function startOfIstDay(d: Date): Date {
  const w = toIstWall(d);
  w.setUTCHours(0, 0, 0, 0);
  return fromIstWall(w);
}

/** IST calendar date as YYYY-MM-DD. */
export function istDateKey(d: Date): string {
  const w = toIstWall(d);
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

/** Monday 00:00 IST of the week containing d. */
export function startOfIstWeek(d: Date): Date {
  const w = toIstWall(d);
  const dow = (w.getUTCDay() + 6) % 7; // Monday = 0
  w.setUTCDate(w.getUTCDate() - dow);
  w.setUTCHours(0, 0, 0, 0);
  return fromIstWall(w);
}

export function startOfIstMonth(d: Date): Date {
  const w = toIstWall(d);
  w.setUTCDate(1);
  w.setUTCHours(0, 0, 0, 0);
  return fromIstWall(w);
}

export type PeriodKind = "WEEK" | "MONTH";

export function periodRange(kind: PeriodKind, anchor: Date): { start: Date; end: Date } {
  if (kind === "WEEK") {
    const start = startOfIstWeek(anchor);
    return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
  }
  const start = startOfIstMonth(anchor);
  const w = toIstWall(start);
  w.setUTCMonth(w.getUTCMonth() + 1);
  return { start, end: fromIstWall(w) };
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function isWeekend(d: Date): boolean {
  const dow = toIstWall(d).getUTCDay();
  return dow === 0; // Sunday off; Saturday is a working day for Nextenti ops
}

export function isWorkingDay(d: Date, holidays: Set<string>): boolean {
  return !isWeekend(d) && !holidays.has(istDateKey(d));
}

/** Add N working days (skipping Sundays and holidays), keeping the time of day. */
export function addWorkingDays(d: Date, n: number, holidays: Set<string>): Date {
  let cur = new Date(d);
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    if (isWorkingDay(cur, holidays)) left--;
  }
  return cur;
}

/** Parse DD-MM-YYYY, YYYY-MM-DD, or an Excel serial / Date into a Date (IST midnight). */
export function parseFlexibleDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") {
    // Excel serial date (1900 system)
    const ms = Math.round((v - 25569) * 86_400_000);
    return new Date(ms - IST_OFFSET_MS);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return fromIstWall(new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return fromIstWall(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** HTML <input type="datetime-local"> value (IST) ⇄ Date */
export function toIstInputValue(d: Date | null | undefined): string {
  if (!d) return "";
  const w = toIstWall(new Date(d));
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
}
export function fromIstInputValue(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return fromIstWall(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0))));
}

export function formatLakhs(v: number | null | undefined): string {
  if (v === null || v === undefined) return "";
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
}
