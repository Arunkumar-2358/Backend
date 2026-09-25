import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { resetDb } from "../helpers";
import { call } from "./client";

beforeEach(resetDb);

const CSV = ["Candidate Name,Mobile No,Main Category,Job Title,Current Location", "Priya S,9848011111,Nursing,Staff Nurse,Hyderabad", "Bad Mobile,98480,Nursing,Staff Nurse,Pune", ""].join("\n");

function multipart(fields: Record<string, string>, file?: { name: string; content: string }) {
  const boundary = "----testboundary";
  const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  if (file) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n${file.content}\r\n`);
  return { payload: `${parts.join("")}--${boundary}--\r\n`, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const upload = (as: string, fields: Record<string, string> = { source: "NAUKRI", category: "NURSE", location: "Hyderabad" }, file: { name: string; content: string } | null = { name: "dump.csv", content: CSV }) =>
  call({ method: "POST", url: "/v1/imports/uploads", as, ...multipart(fields, file ?? undefined) });

describe("HTTP: data import", () => {
  it("uploads a spreadsheet as multipart and returns the normalised wizard state", async () => {
    const res = await upload("greeshma", { source: "BOGUS", category: "NURSE", location: " Hyderabad " });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.file).toMatch(/^imports\//);
    expect(body).toMatchObject({ name: "dump.csv", source: "OTHER", category: "NURSE", location: "Hyderabad" });
  });

  it("refuses uploads from roles outside import and validates the file", async () => {
    expect((await upload("jennifer")).statusCode).toBe(403);
    const noFile = await upload("greeshma", {}, null);
    expect(noFile.statusCode).toBe(422);
    expect(noFile.json().error.message).toMatch(/Choose an \.xlsx or \.csv file/);
    expect((await upload("greeshma", {}, { name: "dump.xls", content: CSV })).json().error.message).toMatch(/Only \.xlsx and \.csv/);
    expect((await upload("greeshma", {}, { name: "empty.csv", content: "Name,Mobile\n" })).json().error.message).toMatch(/no header row or no data rows/);
  });

  it("previews the upload with a suggested mapping for the data analyst only", async () => {
    const { file } = (await upload("greeshma")).json();
    const res = await call({ method: "GET", url: `/v1/imports/uploads?file=${encodeURIComponent(file)}&name=dump.csv`, as: "greeshma" });
    expect(res.statusCode).toBe(200);
    const step = res.json();
    expect(step.headers).toEqual(["Candidate Name", "Mobile No", "Main Category", "Job Title", "Current Location"]);
    expect(step.rowCount).toBe(2);
    expect(step.preview[0][0]).toBe("Priya S");
    expect(step.samples[1]).toBe("9848011111");
    expect(step.mapping).toContain("mobile");
    expect((await call({ method: "GET", url: `/v1/imports/uploads?file=${encodeURIComponent(file)}`, as: "sarala" })).statusCode).toBe(403);
    const missing = await call({ method: "GET", url: "/v1/imports/uploads?file=imports/nope.csv&name=nope.csv", as: "greeshma" });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.message).toMatch(/Upload not found/);
  });

  it("runs the import with the chosen mapping and reports it", async () => {
    const { file } = (await upload("greeshma")).json();
    const mapping = { "0": "name", "1": "mobile", "2": "mainCategory", "3": "jobTitle", "4": "currentLocation" };
    const base = { file, name: "dump.csv", source: "NAUKRI" };

    const noMobile = await call({ method: "POST", url: "/v1/imports", payload: { ...base, mapping: { "0": "name" } }, as: "greeshma" });
    expect(noMobile.statusCode).toBe(422);
    expect(noMobile.json().error.message).toMatch(/Map one column to Mobile/);
    expect((await call({ method: "POST", url: "/v1/imports", payload: { ...base, mapping: { "0": "name", "1": "mobile", "2": "mobile" } }, as: "greeshma" })).json().error.message).toMatch(/Two columns are mapped to Mobile/);
    expect((await call({ method: "POST", url: "/v1/imports", payload: { ...base, mapping }, as: "jennifer" })).statusCode).toBe(403);
    // Team 1 leader may upload but the pipeline itself is data analyst / admin only.
    expect((await call({ method: "POST", url: "/v1/imports", payload: { ...base, mapping }, as: "sarala" })).statusCode).toBe(403);

    const ok = await call({ method: "POST", url: "/v1/imports", payload: { ...base, mapping, saveMappingAs: "My export" }, as: "greeshma" });
    expect(ok.statusCode).toBe(200);
    const id = ok.json().id as string;
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id } });
    expect(batch).toMatchObject({ fileKey: file, totalRows: 2, invalidRows: 1, mappingName: "My export" });

    const history = (await call({ method: "GET", url: "/v1/imports", as: "greeshma" })).json();
    expect(history.total).toBe(1);
    expect(history.batches[0].uploadedBy.name).toBe("Greeshma");
    expect((await call({ method: "GET", url: "/v1/imports", as: "sarala" })).statusCode).toBe(403);

    // The import area is data analyst / admin only (the app's route gating); leaders cannot open reports either.
    expect((await call({ method: "GET", url: `/v1/imports/${id}`, as: "sarala" })).statusCode).toBe(403);
    const report = await call({ method: "GET", url: `/v1/imports/${id}`, as: "greeshma" });
    expect(report.statusCode).toBe(200);
    const r = report.json();
    expect(r.rejectTotal).toBe(1);
    expect(r.rejects[0].status).toBe("INVALID_MOBILE");
    expect(r.rejects[0].raw).toContainEqual(["Candidate Name", "Bad Mobile"]);
    expect(r.statusCount.INVALID_MOBILE).toBe(1);
    expect((await call({ method: "GET", url: `/v1/imports/${id}?status=INVALID_MOBILE`, as: "greeshma" })).json().status).toBe("INVALID_MOBILE");
    expect((await call({ method: "GET", url: `/v1/imports/${id}`, as: "jennifer" })).statusCode).toBe(403);
    expect((await call({ method: "GET", url: "/v1/imports/nope", as: "greeshma" })).statusCode).toBe(404);
    expect((await call({ method: "GET", url: `/v1/imports/${id}/rejects`, as: "greeshma" })).statusCode).toBe(200);
  });

  it("refuses to overwrite a built-in preset mapping", async () => {
    const { file } = (await upload("greeshma")).json();
    const preset = await prisma.importMapping.upsert({ where: { name: "Naukri" }, create: { name: "Naukri", mapping: {}, isPreset: true }, update: { isPreset: true } });
    const res = await call({ method: "POST", url: "/v1/imports", payload: { file, name: "dump.csv", mapping: { "0": "name", "1": "mobile" }, saveMappingAs: preset.name }, as: "greeshma" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/built-in preset/);
  });
});
