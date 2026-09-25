/**
 * The CV Register's 34 columns, mapped to Candidate fields. Drives forms,
 * import column mapping, exports and the profile-completeness checklist.
 */
export type FieldType = "text" | "number" | "int" | "date" | "enum" | "list" | "bool" | "file" | "mobile" | "email" | "readonly";

export type FieldDef = {
  key: string;
  label: string;
  type: FieldType;
  group: "Identity" | "Qualification" | "Profile" | "Commercials" | "Source" | "Files" | "Compliance" | "Ops";
  options?: readonly string[];
  importable?: boolean;
};

export const MAIN_CATEGORIES = ["DOCTOR", "NURSE", "PHARMACY", "ALLIED", "ADMIN", "OTHER"] as const;
export const LEAD_SOURCES = [
  "CONVENTIONAL_MARKETING",
  "NT",
  "NAUKRI",
  "LINKEDIN",
  "INDEED",
  "REFERRAL",
  "DIGITAL_MARKETING",
  "OTHER_PORTAL",
  "OTHER",
] as const;
/** Non-NT = outside job portals (PLAN §1). Everything else is Nextenti's own funnel. */
export const NON_NT_SOURCES = ["NAUKRI", "LINKEDIN", "INDEED", "OTHER_PORTAL"] as const;
export const isNtSourceFor = (source: string) => !(NON_NT_SOURCES as readonly string[]).includes(source);

export const CV_REGISTER_FIELDS: FieldDef[] = [
  { key: "candidateCode", label: "Candidate code", type: "readonly", group: "Identity" },
  { key: "name", label: "Name", type: "text", group: "Identity", importable: true },
  { key: "mobile", label: "Mobile", type: "mobile", group: "Identity", importable: true },
  { key: "altMobile", label: "Alternate mobile", type: "mobile", group: "Identity", importable: true },
  { key: "email", label: "Email", type: "email", group: "Identity", importable: true },
  { key: "basicQualification", label: "Basic qualification", type: "text", group: "Qualification", importable: true },
  { key: "additionalQualifications", label: "Additional qualifications", type: "list", group: "Qualification", importable: true },
  { key: "registrationNumber", label: "Registration number", type: "text", group: "Qualification", importable: true },
  { key: "registrationAuthority", label: "Registration authority", type: "text", group: "Qualification", importable: true },
  { key: "registrationYear", label: "Registration year", type: "int", group: "Qualification", importable: true },
  { key: "mainCategory", label: "Main category", type: "enum", options: MAIN_CATEGORIES, group: "Profile", importable: true },
  { key: "professionFunctionalHead", label: "Profession / functional head", type: "text", group: "Profile", importable: true },
  { key: "jobTitle", label: "Job title", type: "text", group: "Profile", importable: true },
  { key: "primarySpecialty", label: "Primary specialty", type: "text", group: "Profile", importable: true },
  { key: "secondarySkills", label: "Secondary skills", type: "list", group: "Profile", importable: true },
  { key: "experienceYears", label: "Experience (years)", type: "number", group: "Profile", importable: true },
  { key: "currentOrg", label: "Current organisation", type: "text", group: "Profile", importable: true },
  { key: "currentDesignation", label: "Current designation", type: "text", group: "Profile", importable: true },
  { key: "currentLocation", label: "Current location", type: "text", group: "Profile", importable: true },
  { key: "preferredLocations", label: "Preferred locations (priority order)", type: "list", group: "Profile", importable: true },
  { key: "currentCtcLakhs", label: "Current CTC (₹ lakhs)", type: "number", group: "Commercials", importable: true },
  { key: "expectedCtcLakhs", label: "Expected CTC (₹ lakhs)", type: "number", group: "Commercials", importable: true },
  { key: "noticePeriodDays", label: "Notice period (days)", type: "int", group: "Commercials", importable: true },
  { key: "earliestAvailabilityDate", label: "Earliest availability", type: "date", group: "Commercials", importable: true },
  { key: "availabilityStatus", label: "Availability status", type: "enum", options: ["IMMEDIATE", "SERVING_NOTICE", "NOT_LOOKING", "UNKNOWN"], group: "Commercials", importable: true },
  { key: "shiftPreference", label: "Shift preference", type: "enum", options: ["DAY", "NIGHT", "ROTATIONAL", "ANY"], group: "Commercials", importable: true },
  { key: "employmentPreference", label: "Employment preference", type: "enum", options: ["FULL_TIME", "PART_TIME", "LOCUM", "CONTRACT"], group: "Commercials", importable: true },
  { key: "source", label: "Source", type: "enum", options: LEAD_SOURCES, group: "Source", importable: true },
  { key: "resumeFileKey", label: "Resume", type: "file", group: "Files" },
  { key: "introVideoKey", label: "Intro video (1 min)", type: "file", group: "Files" },
  { key: "consentRecordStoreShare", label: "Consent to store & share", type: "bool", group: "Compliance", importable: true },
  { key: "tlRemarks", label: "TL remarks", type: "text", group: "Ops", importable: true },
  { key: "verificationStatus", label: "Verification status", type: "readonly", group: "Ops" },
  { key: "stage", label: "Stage", type: "readonly", group: "Ops" },
];

export const FIELD_BY_KEY = Object.fromEntries(CV_REGISTER_FIELDS.map((f) => [f.key, f]));

export function fieldLabel(key: string) {
  return FIELD_BY_KEY[key]?.label ?? key;
}

/** Plain (decrypted) candidate view used by completeness, forms, gates. */
export type CandidatePlain = Record<string, unknown> & { mobile: string | null; email: string | null; altMobile: string | null };

export function isFilled(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return !Number.isNaN(v);
  return true;
}

export function missingMandatory(c: CandidatePlain, mandatory: string[]): string[] {
  return mandatory.filter((k) => !isFilled(c[k]));
}

export function completenessPct(c: CandidatePlain, mandatory: string[]): number {
  if (!mandatory.length) return 100;
  const filled = mandatory.length - missingMandatory(c, mandatory).length;
  return Math.round((filled / mandatory.length) * 100);
}
