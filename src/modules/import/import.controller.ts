import { z } from "zod";
import { Controller, Module } from "@nestjs/common";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { pageQuery } from "@/http/schemas";
import { prisma } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { assert, hasRole } from "@/lib/rbac";
import { storage } from "@/modules/storage";
import { ALLOWED_EXT, IMPORT_ROLES, MAX_IMPORT_BYTES, TARGET_KEYS, parseCategoryParam, parseSourceParam } from "@contracts/shared/d-import";
import { parseSpreadsheet } from "./parse";
import { runImport, type ColumnMapping } from "./pipeline";
import { importHistory, importReport, loadUpload, mappingStep } from "./queries";

const IMPORT_DENIED = "Only the data analyst, Team 1 leader or admin can import data";
const WIZARD_DENIED = "Data import (bulk upload and mapping) is for the data analyst and admin";

/** Optional trimmed text; blank means "not given" (like the web's str()). */
const text = z
  .string()
  .max(2000)
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

/** Multipart text fields of the upload step (validated like any other request input). */
const uploadFields = z
  .object({
    source: z.string().trim().max(40).optional(),
    category: z.string().trim().max(40).optional(),
    location: z.string().trim().max(120).regex(/^[\p{L}\p{N} .,'()/-]*$/u, "contains unsupported characters").optional(),
  })
  .passthrough()
  .transform((v) => ({ source: v.source || undefined, category: v.category || undefined, location: v.location || undefined }));

@Controller()
export class ImportsController {
  @Endpoint("GET /v1/imports", {
    summary: "Import history (data analyst / admin)",
    query: z.object({ page: pageQuery.optional() }),
  })
  async getImports({ actor, query }: Ctx<"GET /v1/imports">) {
    assert(hasRole(actor, "data_analyst", "admin"), WIZARD_DENIED);
    return importHistory(query);
  }

  @Endpoint("POST /v1/imports/uploads", {
    summary: "Step 1: upload a spreadsheet (multipart: file, source, category, location) and store it for mapping",
  })
  async postImportsUploads({ actor, req }: Ctx<"POST /v1/imports/uploads">) {
    assert(hasRole(actor, ...IMPORT_ROLES), IMPORT_DENIED);
    if (!req.isMultipart()) throw new ValidationError("Expected multipart/form-data");
    const fields: Record<string, string> = {};
    let file: { name: string; data: Buffer } | undefined;
    for await (const part of req.parts({ limits: { fileSize: MAX_IMPORT_BYTES + 1, files: 1 } })) {
      if (part.type !== "file") fields[part.fieldname] = String(part.value);
      else if (part.fieldname === "file" && !file) file = { name: part.filename, data: await part.toBuffer() };
      else part.file.resume(); // drain parts we do not use, without buffering them
    }
    if (!file || file.data.length === 0) throw new ValidationError("Choose an .xlsx or .csv file to upload");
    if (file.data.length > MAX_IMPORT_BYTES) throw new ValidationError("File is larger than 25 MB — split it into smaller files");
    const lower = file.name.toLowerCase();
    if (!ALLOWED_EXT.some((e) => lower.endsWith(e))) throw new ValidationError("Only .xlsx and .csv files are supported (save .xls files as .xlsx first)");
    let parsed: Awaited<ReturnType<typeof parseSpreadsheet>>;
    try {
      parsed = await parseSpreadsheet(file.name, file.data);
    } catch {
      throw new ValidationError("Could not read that file — is it a valid .xlsx / .csv?");
    }
    if (!parsed.headers.length || !parsed.rows.length) throw new ValidationError("The file has no header row or no data rows");
    // Validate every input before storing anything, so a rejected request leaves no orphaned upload.
    const f = uploadFields.safeParse(fields);
    if (!f.success) throw new ValidationError(`${f.error.issues[0]?.path.join(".")}: ${f.error.issues[0]?.message}`);
    const key = await storage.put("imports", file.name, file.data);
    const category = parseCategoryParam(f.data.category);
    const location = f.data.location;
    return {
      message: "File uploaded",
      file: key,
      name: file.name,
      source: parseSourceParam(f.data.source),
      ...(category ? { category } : {}),
      ...(location ? { location } : {}),
    };
  }

  @Endpoint("GET /v1/imports/uploads", {
    summary: "Step 2: preview and suggested column mapping for a stored upload (data analyst / admin)",
    query: z.object({ file: z.string().optional(), name: z.string().optional(), preset: z.string().optional() }),
  })
  async getImportsUploads({ actor, query }: Ctx<"GET /v1/imports/uploads">) {
    assert(hasRole(actor, "data_analyst", "admin"), WIZARD_DENIED);
    return mappingStep(query);
  }

  @Endpoint("POST /v1/imports", {
    summary: "Step 2: apply the column mapping and run the validation pipeline",
    body: z.object({ file: text, name: text, source: text, category: text, location: text, mapping: z.record(z.string()), saveMappingAs: text }),
  })
  async postImports({ actor, body }: Ctx<"POST /v1/imports">) {
    assert(hasRole(actor, ...IMPORT_ROLES), IMPORT_DENIED);
    const fileKey = body.file;
    const fileName = body.name ?? "import.xlsx";
    const { headers, rows } = await loadUpload(fileKey, fileName);
    if (!rows.length) throw new ValidationError("The file has no data rows");

    const mapping: ColumnMapping = {};
    headers.forEach((h, i) => {
      const target = body.mapping[String(i)]?.trim() ?? "";
      mapping[h] = TARGET_KEYS.has(target) ? target : "";
    });
    const targets = Object.values(mapping).filter(Boolean);
    if (!targets.includes("mobile")) throw new ValidationError("Map one column to Mobile — it is required for dedupe and validation");
    if (!targets.includes("name") && !targets.includes("firstName")) throw new ValidationError("Map a column to Name (or First name)");
    // mapRow keeps the first non-empty value per field; block ambiguity on the identity fields.
    for (const k of ["mobile", "name"]) if (targets.filter((t) => t === k).length > 1) throw new ValidationError(`Two columns are mapped to ${k === "mobile" ? "Mobile" : "Name"} — choose one`);

    const saveAs = body.saveMappingAs;
    if (saveAs) {
      const preset = await prisma.importMapping.findUnique({ where: { name: saveAs } });
      if (preset?.isPreset) throw new ValidationError(`"${saveAs}" is a built-in preset — save under a different name`);
    }

    const { batch } = await runImport(actor, {
      fileName,
      rows,
      mapping,
      source: parseSourceParam(body.source),
      saveMappingAs: saveAs,
      defaults: { mainCategory: parseCategoryParam(body.category), currentLocation: body.location },
    });
    await prisma.importBatch.update({ where: { id: batch.id }, data: { fileKey } });
    return { message: "Import finished", id: batch.id };
  }

  @Endpoint("GET /v1/imports/{batchId}", {
    summary: "Import report: created-lead groups and rejected / flagged rows (data analyst, Team 1 leader, admin)",
    params: z.object({ batchId: z.string().min(1) }),
    query: z.object({ page: pageQuery.optional(), status: z.string().optional() }),
  })
  async getImportsDetail({ actor, params, query }: Ctx<"GET /v1/imports/{batchId}">) {
    assert(hasRole(actor, "data_analyst", "admin", "team1_leader"), "Import reports are for the data analyst, Team 1 leader and admin");
    return importReport(params.batchId, query);
  }
}

@Module({ controllers: [ImportsController] })
export class ImportsModule {}
