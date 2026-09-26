/** Masks candidate contact details in free text before it leaves the system (error reports, logs). */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Stored-file paths (/v1/files/<key>, /api/v1/files/<key>): keys embed original filenames, often the candidate's name.
const FILE_PATH = /(\/files\/)[^?#\s"']+/g;
// 10-digit Indian mobiles, optionally with +91 / 0 prefixes and separators.
const MOBILE = /(?:\+?91[\s-]?|0)?[6-9](?:[\s-]?\d){9}\b/g;

export function maskPii(text: string): string {
  return text.replace(FILE_PATH, "$1[file]").replace(EMAIL, "[email]").replace(MOBILE, "[mobile]");
}

/** Deep-copies a JSON-ish value with every string masked. */
export function maskPiiDeep<T>(v: T, depth = 0): T {
  // Past the depth limit nothing is inspected, so nothing is let through.
  if (depth > 6) return (v && typeof v === "object") || typeof v === "string" ? ("[redacted]" as T) : v;
  if (typeof v === "string") return maskPii(v) as T;
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => maskPiiDeep(x, depth + 1)) as T;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskPiiDeep(x, depth + 1)])) as T;
}
