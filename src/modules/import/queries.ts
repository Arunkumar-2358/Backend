import type { ImportRowStatus, Prisma } from "@prisma/client";
import type { ImportHistory, ImportMappingStep, ImportReport } from "@contracts";
import { prisma } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { notFound } from "@/plugins/errors";
import { storage } from "@/modules/storage";
import { PRESETS, norm } from "@contracts/shared/import-presets";
import { TARGET_KEYS, cellText, isImportKey } from "@contracts/shared/d-import";
import { parseSpreadsheet } from "./parse";
import { autoMap, batchGroups, type ColumnMapping } from "./pipeline";

const HISTORY_PAGE_SIZE = 20;
const REPORT_PAGE_SIZE = 50;
const REJECT_STATUSES: ImportRowStatus[] = ["NEEDS_MAPPING", "DUPLICATE_IN_FILE", "DUPLICATE_IN_DB", "INVALID_MOBILE", "ERROR"];

/** Load an uploaded spreadsheet from storage and parse it. */
export async function loadUpload(fileKey: string | undefined, fileName: string | undefined) {
  if (!isImportKey(fileKey)) throw new ValidationError("Upload not found — please upload the file again");
  let buf: Buffer;
  try {
    buf = await storage.get(fileKey);
  } catch {
    throw new ValidationError("Upload not found — please upload the file again");
  }
  return parseSpreadsheet(fileName || fileKey, buf);
}

/** Keep only fields the wizard knows about (drops e.g. readonly candidateCode). */
export function cleanMapping(m: ColumnMapping): ColumnMapping {
  return Object.fromEntries(Object.entries(m).map(([h, f]) => [h, TARGET_KEYS.has(f) ? f : ""]));
}

/** Apply a saved mapping (keys = source headers, matched case/space-insensitively). */
export function applySavedMapping(headers: string[], saved: Record<string, string>): ColumnMapping {
  const entries = Object.entries(saved);
  return cleanMapping(Object.fromEntries(headers.map((h) => [h, saved[h] ?? entries.find(([k]) => norm(k) === norm(h))?.[1] ?? ""])));
}

export function suggestMapping(headers: string[], presetName: string | undefined, saved: Record<string, string> | null): ColumnMapping {
  if (saved) return applySavedMapping(headers, saved);
  return cleanMapping(autoMap(headers, presetName && PRESETS[presetName] ? presetName : undefined));
}

export async function importHistory(q: { page?: number }): Promise<ImportHistory> {
  const page = Math.max(1, q.page || 1);
  const [batches, total] = await Promise.all([
    prisma.importBatch.findMany({ orderBy: { createdAt: "desc" }, skip: (page - 1) * HISTORY_PAGE_SIZE, take: HISTORY_PAGE_SIZE, include: { uploadedBy: { select: { name: true } } } }),
    prisma.importBatch.count(),
  ]);
  return { batches, total, page, pageSize: HISTORY_PAGE_SIZE };
}

/** Step 2 of the wizard: headers, preview and the suggested column mapping for a stored upload. */
export async function mappingStep(q: { file?: string; name?: string; preset?: string }): Promise<ImportMappingStep> {
  const fileName = q.name ?? "import.xlsx";
  let parsed: Awaited<ReturnType<typeof loadUpload>>;
  try {
    parsed = await loadUpload(q.file, fileName);
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(e instanceof Error ? e.message : String(e));
  }
  const { headers, rows } = parsed;
  const savedMappings = await prisma.importMapping.findMany({ orderBy: [{ isPreset: "desc" }, { name: "asc" }] });
  const chosen = q.preset ? savedMappings.find((m) => m.name === q.preset) : undefined;
  const mapping = suggestMapping(headers, q.preset, chosen ? (chosen.mapping as Record<string, string>) : null);
  return {
    fileName,
    headers,
    rowCount: rows.length,
    preview: rows.slice(0, 5).map((r) => headers.map((h) => cellText(r[h]))),
    samples: headers.map((h) => cellText(rows.find((r) => cellText(r[h]).trim() !== "")?.[h])),
    mapping: headers.map((h) => mapping[h] ?? ""),
    savedMappings: savedMappings.map((m) => ({ name: m.name, isPreset: m.isPreset })),
    chosen: chosen ? { name: chosen.name, isPreset: chosen.isPreset } : null,
  };
}

export async function importReport(batchId: string, q: { page?: number; status?: string }): Promise<ImportReport> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, include: { uploadedBy: { select: { name: true } } } });
  if (!batch) throw notFound("Import batch not found");

  const status = REJECT_STATUSES.includes(q.status as ImportRowStatus) ? (q.status as ImportRowStatus) : undefined;
  const page = Math.max(1, q.page || 1);
  const where: Prisma.ImportRowWhereInput = { batchId, status: status ?? { not: "ACCEPTED" } };
  const [groups, rejects, rejectTotal, byStatus] = await Promise.all([
    batchGroups(batchId),
    prisma.importRow.findMany({ where, orderBy: { rowNumber: "asc" }, skip: (page - 1) * REPORT_PAGE_SIZE, take: REPORT_PAGE_SIZE }),
    prisma.importRow.count({ where }),
    prisma.importRow.groupBy({ by: ["status"], where: { batchId }, _count: true }),
  ]);
  return {
    batch,
    groups,
    rejects: rejects.map((r) => ({
      id: r.id,
      rowNumber: r.rowNumber,
      status: r.status,
      rejectionReason: r.rejectionReason,
      candidateId: r.candidateId,
      raw: Object.entries((r.raw ?? {}) as Record<string, unknown>)
        .map(([k, v]): [string, string] => [k, cellText(v)])
        .filter(([, v]) => v.trim() !== ""),
    })),
    rejectTotal,
    statusCount: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
    status: status ?? null,
    page,
    pageSize: REPORT_PAGE_SIZE,
  };
}
