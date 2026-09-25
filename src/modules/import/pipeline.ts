import type { ImportRowStatus, LeadSource, MainCategory } from "@prisma/client";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { validateMobile } from "@contracts/shared/phone";
import { parseFlexibleDate } from "@contracts/shared/dates";
import { GateError, errorMessage } from "@/lib/errors";
import { type Actor, ForbiddenError, SYSTEM, actorId, hasRole } from "@/lib/rbac";
import { createCandidate, findByEmail, findByMobile, type CandidateInput } from "@/modules/candidates/service";
import { LEAD_SOURCES } from "@contracts/shared/fields";
import { transitionLead } from "@/modules/lifecycle/transition";
import { notify } from "@/modules/notifications/service";
import { PRESETS, norm } from "@contracts/shared/import-presets";
import type { RawRow } from "./parse";

export type ColumnMapping = Record<string, string>; // source header → field key ("" = ignore)

/** Suggest a mapping for headers using a preset (or all presets). */
export function autoMap(headers: string[], presetName?: string): ColumnMapping {
  const presets = presetName && PRESETS[presetName] ? [PRESETS[presetName]] : Object.values(PRESETS);
  const out: ColumnMapping = {};
  for (const h of headers) {
    let field = "";
    for (const p of presets) {
      const hit = Object.entries(p).find(([k]) => norm(k) === norm(h));
      if (hit) { field = hit[1]; break; }
    }
    out[h] = field;
  }
  return out;
}

const CATEGORY_WORDS: [RegExp, MainCategory][] = [
  [/\b(doctor|mbbs|md|ms|physician|surgeon|consultant|resident|dnb|hni|executive)\b/i, "DOCTOR"],
  [/\b(nurs|gnm|anm|bsc nursing|staff nurse|midwife)/i, "NURSE"],
  [/\b(pharm|d\.?pharm|b\.?pharm|chemist)/i, "PHARMACY"],
  [/\b(allied|lab|technician|technologist|physio|radiograph|dialysis|optom|ot tech|mlt|dmlt)/i, "ALLIED"],
  [/\b(admin|front office|billing|hr|accounts|receptionist)/i, "ADMIN"],
];

export function parseCategory(v: unknown): MainCategory | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const s = String(v).trim();
  const upper = s.toUpperCase();
  if (["DOCTOR", "NURSE", "PHARMACY", "ALLIED", "ADMIN", "OTHER"].includes(upper)) return upper as MainCategory;
  for (const [re, cat] of CATEGORY_WORDS) if (re.test(s)) return cat;
  return "OTHER";
}

export function parseSource(v: unknown, fallback: LeadSource): LeadSource {
  if (!v) return fallback;
  const s = String(v).trim().toUpperCase().replace(/[\s-]+/g, "_");
  if ((LEAD_SOURCES as readonly string[]).includes(s)) return s as LeadSource;
  if (/NAUKRI/.test(s)) return "NAUKRI";
  if (/LINKEDIN/.test(s)) return "LINKEDIN";
  if (/INDEED/.test(s)) return "INDEED";
  if (/REFER/.test(s)) return "REFERRAL";
  if (/NEXTENTI|^NT$/.test(s)) return "NT";
  if (/DIGITAL|SOCIAL|FACEBOOK|INSTAGRAM|GOOGLE/.test(s)) return "DIGITAL_MARKETING";
  if (/PORTAL|MONSTER|SHINE|APNA|WORKINDIA/.test(s)) return "OTHER_PORTAL";
  return fallback;
}

const num = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(/[₹,\s]|lakhs?|lpa|yrs?|years?|days?/gi, ""));
  return Number.isFinite(n) ? n : null;
};
const list = (v: unknown) => (v === null || v === undefined || v === "" ? [] : String(v).split(/[,;|/]/).map((s) => s.trim()).filter(Boolean));
const bool = (v: unknown) => /^(y|yes|true|1|given|consented)$/i.test(String(v ?? "").trim());
const str = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? undefined : String(v).trim());
const enumOf = <T extends string>(v: unknown, opts: readonly T[]) => {
  const s = String(v ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return (opts as readonly string[]).includes(s) ? (s as T) : undefined;
};

/** Apply a column mapping to a raw row → CandidateInput. */
export function mapRow(raw: RawRow, mapping: ColumnMapping, source: LeadSource): CandidateInput & { name?: string; mobile?: string } {
  const f: Record<string, unknown> = {};
  for (const [header, field] of Object.entries(mapping)) {
    if (!field) continue;
    const v = raw[header];
    if (v === null || v === undefined || v === "") continue;
    f[field] = f[field] === undefined ? v : f[field];
  }
  const name = str(f.name) ?? ([str(f.firstName), str(f.lastName)].filter(Boolean).join(" ") || undefined);
  const out: CandidateInput & { name?: string; mobile?: string } = {
    name,
    mobile: f.mobile === undefined ? undefined : String(f.mobile),
    altMobile: f.altMobile === undefined ? undefined : String(f.altMobile),
    email: str(f.email),
    basicQualification: str(f.basicQualification),
    additionalQualifications: list(f.additionalQualifications),
    registrationNumber: str(f.registrationNumber),
    registrationAuthority: str(f.registrationAuthority),
    registrationYear: num(f.registrationYear) ?? undefined,
    mainCategory: parseCategory(f.mainCategory ?? f.jobTitle ?? f.professionFunctionalHead) ?? undefined,
    professionFunctionalHead: str(f.professionFunctionalHead),
    jobTitle: str(f.jobTitle),
    primarySpecialty: str(f.primarySpecialty),
    secondarySkills: list(f.secondarySkills),
    experienceYears: num(f.experienceYears) ?? undefined,
    currentOrg: str(f.currentOrg),
    currentDesignation: str(f.currentDesignation),
    currentLocation: str(f.currentLocation),
    preferredLocations: list(f.preferredLocations),
    currentCtcLakhs: num(f.currentCtcLakhs) ?? undefined,
    expectedCtcLakhs: num(f.expectedCtcLakhs) ?? undefined,
    noticePeriodDays: num(f.noticePeriodDays) ?? undefined,
    earliestAvailabilityDate: parseFlexibleDate(f.earliestAvailabilityDate) ?? undefined,
    availabilityStatus: enumOf(f.availabilityStatus, ["IMMEDIATE", "SERVING_NOTICE", "NOT_LOOKING", "UNKNOWN"] as const),
    shiftPreference: enumOf(f.shiftPreference, ["DAY", "NIGHT", "ROTATIONAL", "ANY"] as const),
    employmentPreference: enumOf(f.employmentPreference, ["FULL_TIME", "PART_TIME", "LOCUM", "CONTRACT"] as const),
    source: parseSource(f.source, source),
    consentRecordStoreShare: f.consentRecordStoreShare === undefined ? undefined : bool(f.consentRecordStoreShare),
    tlRemarks: str(f.tlRemarks),
  };
  if (out.registrationYear !== undefined) out.registrationYear = Math.round(out.registrationYear as number);
  if (out.noticePeriodDays !== undefined) out.noticePeriodDays = Math.round(out.noticePeriodDays as number);
  for (const k of Object.keys(out) as (keyof typeof out)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export type ImportOptions = {
  fileName: string;
  rows: RawRow[];
  mapping: ColumnMapping;
  source: LeadSource;
  saveMappingAs?: string;
  defaults?: { mainCategory?: MainCategory; currentLocation?: string };
};

/**
 * Validation pipeline (M1): normalise mobiles → reject non-10-digit → dedupe
 * within file and against the DB (mobile, then email) → create lead in Mapping →
 * auto-advance to Validated when the mapping gate passes.
 */
export async function runImport(actor: Actor, opts: ImportOptions) {
  if (actor.kind === "user" && !hasRole(actor, "data_analyst", "admin")) throw new ForbiddenError("Only the data analyst can bulk-import data. TA leads add a single non-NT portal lead from their Outreach queue instead.");
  const batch = await prisma.importBatch.create({
    data: { fileName: opts.fileName, status: "PROCESSING", totalRows: opts.rows.length, source: opts.source, uploadedById: actorId(actor), mappingName: opts.saveMappingAs, createdAt: now() },
  });
  if (opts.saveMappingAs) {
    await prisma.importMapping.upsert({ where: { name: opts.saveMappingAs }, create: { name: opts.saveMappingAs, mapping: opts.mapping }, update: { mapping: opts.mapping } });
  }
  const seenMobiles = new Map<string, number>();
  const seenEmails = new Map<string, number>();
  const counts: Record<ImportRowStatus, number> = { ACCEPTED: 0, NEEDS_MAPPING: 0, DUPLICATE_IN_FILE: 0, DUPLICATE_IN_DB: 0, INVALID_MOBILE: 0, ERROR: 0 };
  const importActor = actor.kind === "user" ? actor : SYSTEM("import");

  for (let i = 0; i < opts.rows.length; i++) {
    const raw = opts.rows[i];
    const rowNumber = i + 2; // header is row 1
    let status: ImportRowStatus = "ACCEPTED";
    let reason: string | null = null;
    let candidateId: string | null = null;
    try {
      const input = mapRow(raw, opts.mapping, opts.source);
      if (opts.defaults?.mainCategory && !input.mainCategory) input.mainCategory = opts.defaults.mainCategory;
      if (opts.defaults?.currentLocation && !input.currentLocation) input.currentLocation = opts.defaults.currentLocation;
      const m = validateMobile(input.mobile);
      const email = input.email?.toLowerCase();
      if (!m.ok) {
        status = "INVALID_MOBILE";
        reason = m.reason;
      } else if (seenMobiles.has(m.mobile)) {
        status = "DUPLICATE_IN_FILE";
        reason = `Duplicate mobile of row ${seenMobiles.get(m.mobile)}`;
      } else if (email && seenEmails.has(email)) {
        status = "DUPLICATE_IN_FILE";
        reason = `Duplicate email of row ${seenEmails.get(email)}`;
      } else {
        seenMobiles.set(m.mobile, rowNumber);
        if (email) seenEmails.set(email, rowNumber);
        const byMobile = await findByMobile(m.mobile);
        const byEmail = !byMobile && email ? await findByEmail(email) : null;
        if (byMobile || byEmail) {
          status = "DUPLICATE_IN_DB";
          reason = `Already in database as ${(byMobile ?? byEmail)!.candidateCode} (matched by ${byMobile ? "mobile" : "email"})`;
        } else if (!input.name) {
          status = "ERROR";
          reason = "Name missing";
        } else {
          const res = await prisma.$transaction(async (tx) => {
            const c = await createCandidate(importActor, { ...input, name: input.name!, mobile: m.mobile }, { importBatchId: batch.id }, tx);
            try {
              await transitionLead(SYSTEM("import"), c.id, "VALIDATED", { note: `Imported (batch ${batch.fileName})`, source: "import" }, tx);
              return { id: c.id, needs: null as string | null };
            } catch (e) {
              if (e instanceof GateError) return { id: c.id, needs: e.failures.join("; ") };
              throw e;
            }
          });
          candidateId = res.id;
          if (res.needs) {
            status = "NEEDS_MAPPING";
            reason = res.needs;
          }
        }
      }
    } catch (e) {
      status = "ERROR";
      reason = errorMessage(e);
    }
    counts[status]++;
    await prisma.importRow.create({ data: { batchId: batch.id, rowNumber, raw: JSON.parse(JSON.stringify(raw)), status, rejectionReason: reason, candidateId } });
  }

  const done = await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: "COMPLETED",
      completedAt: now(),
      acceptedRows: counts.ACCEPTED,
      needsMappingRows: counts.NEEDS_MAPPING,
      duplicateRows: counts.DUPLICATE_IN_DB + counts.DUPLICATE_IN_FILE,
      invalidRows: counts.INVALID_MOBILE + counts.ERROR,
    },
  });
  await audit(actor, "IMPORT", "import_batch", batch.id, counts);
  await notify(actorId(actor), { kind: "IMPORT", title: `Import finished: ${opts.fileName}`, body: `${counts.ACCEPTED} accepted · ${counts.NEEDS_MAPPING} need mapping · ${counts.DUPLICATE_IN_FILE + counts.DUPLICATE_IN_DB} duplicates · ${counts.INVALID_MOBILE + counts.ERROR} rejected`, link: `/import/${batch.id}` });
  const byOwner = await prisma.candidate.groupBy({ by: ["ownerUserId"], where: { importBatchId: batch.id, stage: "VALIDATED" }, _count: true });
  for (const o of byOwner) {
    await notify(o.ownerUserId, { kind: "LEAD_ASSIGNED", title: `${o._count} new validated lead${o._count === 1 ? "" : "s"} in your queue`, body: `From import ${opts.fileName}`, link: "/queue" }, prisma, actor);
  }
  return { batch: done, counts };
}

/** Group accepted leads of a batch by category/job title and geography. */
export async function batchGroups(batchId: string) {
  const rows = await prisma.candidate.groupBy({
    by: ["mainCategory", "jobTitle", "currentLocation"],
    where: { importBatchId: batchId },
    _count: true,
    orderBy: { _count: { id: "desc" } },
  });
  return rows.map((r) => ({ category: r.mainCategory, jobTitle: r.jobTitle, location: r.currentLocation, count: r._count }));
}

/** Downloadable rejects (raw row + reason). */
export async function rejectsWorkbook(batchId: string): Promise<Buffer> {
  const rows = await prisma.importRow.findMany({ where: { batchId, status: { notIn: ["ACCEPTED"] } }, orderBy: { rowNumber: "asc" } });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Rejects");
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r.raw as object)))];
  ws.addRow(["Row #", "Status", "Reason", ...headers]).font = { bold: true };
  for (const r of rows) {
    const raw = r.raw as Record<string, unknown>;
    ws.addRow([r.rowNumber, r.status, r.rejectionReason, ...headers.map((h) => (raw[h] === null || raw[h] === undefined ? "" : String(raw[h])))]);
  }
  ws.columns.forEach((c) => (c.width = 20));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
