// Endpoints for the imports domain. See contracts/README.md.
import type { ImportBatch, ImportRow, ImportRowStatus, LeadSource, MainCategory, User } from "../models";
import type { MessageResult } from "../http";

export type ImportBatchRow = ImportBatch & { uploadedBy: Pick<User, "name"> | null };

export interface ImportHistory {
  batches: ImportBatchRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Where the wizard goes after a successful upload: the stored file plus the normalised defaults. */
export interface ImportUploadResult extends MessageResult {
  file: string;
  name: string;
  source: LeadSource;
  category?: MainCategory;
  location?: string;
}

/** The column-mapping step for an uploaded file. Cell values are pre-rendered as text. */
export interface ImportMappingStep {
  fileName: string;
  headers: string[];
  rowCount: number;
  /** First 5 rows, one text cell per header. */
  preview: string[][];
  /** First non-empty value per header. */
  samples: string[];
  /** Suggested target field per header ("" = ignore). */
  mapping: string[];
  savedMappings: { name: string; isPreset: boolean }[];
  chosen: { name: string; isPreset: boolean } | null;
}

export interface ImportReport {
  batch: ImportBatchRow;
  groups: { category: MainCategory | null; jobTitle: string | null; location: string | null; count: number }[];
  /** Rejected / flagged rows; raw values are pre-rendered text with empty cells dropped. */
  rejects: (Pick<ImportRow, "id" | "rowNumber" | "status" | "rejectionReason" | "candidateId"> & { raw: [string, string][] })[];
  rejectTotal: number;
  statusCount: Partial<Record<ImportRowStatus, number>>;
  status: ImportRowStatus | null;
  page: number;
  pageSize: number;
}

export interface RunImportBody {
  file?: string;
  name?: string;
  source?: string;
  category?: string;
  location?: string;
  /** Target field per header index, e.g. { "0": "name", "1": "mobile" }. */
  mapping: Record<string, string>;
  saveMappingAs?: string;
}

export interface ImportRoutes {
  "GET /v1/imports": { query?: { page?: number }; response: ImportHistory };
  /** Multipart: file, source, category, location. */
  "POST /v1/imports/uploads": { body: FormData; response: ImportUploadResult };
  "GET /v1/imports/uploads": { query: { file?: string; name?: string; preset?: string }; response: ImportMappingStep };
  "POST /v1/imports": { body: RunImportBody; response: MessageResult & { id: string } };
  "GET /v1/imports/{batchId}": { params: { batchId: string }; query?: { page?: number; status?: string }; response: ImportReport };
}
