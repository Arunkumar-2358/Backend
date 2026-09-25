/** Data-import wizard helpers shared by the API (validation) and the web (mapping selects). */
import type { LeadSource, MainCategory } from "../models";
import { CV_REGISTER_FIELDS, LEAD_SOURCES, MAIN_CATEGORIES } from "./fields";

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const ALLOWED_EXT = [".xlsx", ".csv"];
export const IMPORT_ROLES = ["data_analyst", "admin", "team1_leader"] as const;

/** Target fields offered in the column-mapping selects. */
export const TARGET_FIELDS: { value: string; label: string }[] = [
  ...CV_REGISTER_FIELDS.filter((f) => f.importable).map((f) => ({ value: f.key, label: f.label })),
  { value: "firstName", label: "First name (joined with last name)" },
  { value: "lastName", label: "Last name (joined with first name)" },
];
export const TARGET_KEYS = new Set(TARGET_FIELDS.map((f) => f.value));

export function isImportKey(key: string | undefined): key is string {
  return !!key && key.startsWith("imports/") && !key.includes("..") && !key.includes("\\");
}

export const parseSourceParam = (s: string | undefined): LeadSource =>
  s && (LEAD_SOURCES as readonly string[]).includes(s) ? (s as LeadSource) : "OTHER";
export const parseCategoryParam = (s: string | undefined): MainCategory | undefined =>
  s && (MAIN_CATEGORIES as readonly string[]).includes(s) ? (s as MainCategory) : undefined;

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
