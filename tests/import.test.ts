import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { runImport, autoMap, rejectsWorkbook, batchGroups } from "@/modules/import/pipeline";
import { parseSpreadsheet } from "@/modules/import/parse";
import { resetDb, as, userId } from "./helpers";

beforeEach(resetDb);

const HEADERS = ["Candidate Name", "Mobile No", "Email ID", "Main Category", "Job Title", "Current Location", "Source"];
const ROWS = [
  ["Priya S", "+91 98480 11111", "priya@example.com", "Nursing", "Staff Nurse", "Hyderabad", "Conventional marketing"],
  ["Ravi K", "98480-22222", "ravi@example.com", "Pharmacy", "Pharmacist", "Chennai", ""],
  ["Dup Priya", "9848011111", "other@example.com", "Nursing", "Staff Nurse", "Hyderabad", ""], // dup mobile in file
  ["Nine Digits", "984801111", "", "Nursing", "Staff Nurse", "Pune", ""],
  ["Eleven Digits", "98480111112", "", "Nursing", "Staff Nurse", "Pune", ""],
  ["Dup Email", "9848033333", "PRIYA@example.com", "Nursing", "Staff Nurse", "Pune", ""], // dup email in file
  ["No Geo", "9848044444", "", "Doctor", "Resident", "", ""], // needs mapping
  ["Dr Meera", "9848055555", "", "MBBS", "Consultant", "Bengaluru", "LinkedIn"],
];

async function xlsx(headers: string[], rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("import pipeline (M1)", () => {
  it("rejects duplicates and 9/11-digit numbers with reasons, and routes accepted leads", async () => {
    const buf = await xlsx(HEADERS, ROWS);
    const parsed = await parseSpreadsheet("dump.xlsx", buf);
    expect(parsed.rows).toHaveLength(8);
    const { counts, batch } = await runImport(await as("greeshma"), { fileName: "dump.xlsx", rows: parsed.rows, mapping: autoMap(parsed.headers), source: "CONVENTIONAL_MARKETING" });
    expect(counts).toMatchObject({ ACCEPTED: 3, NEEDS_MAPPING: 1, DUPLICATE_IN_FILE: 2, INVALID_MOBILE: 2, DUPLICATE_IN_DB: 0 });
    const rows = await prisma.importRow.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
    expect(rows[2].rejectionReason).toMatch(/Duplicate mobile of row 2/);
    expect(rows[3].rejectionReason).toMatch(/exactly 10 digits.*got 9/);
    expect(rows[4].rejectionReason).toMatch(/got 11/);
    expect(rows[5].rejectionReason).toMatch(/Duplicate email/);
    expect(rows[6].status).toBe("NEEDS_MAPPING");
    expect(rows[6].rejectionReason).toMatch(/Geography/);
    expect(batch).toMatchObject({ totalRows: 8, acceptedRows: 3, duplicateRows: 2, invalidRows: 2, needsMappingRows: 1 });

    const priya = await prisma.candidate.findFirstOrThrow({ where: { name: "Priya S" } });
    expect(priya.stage).toBe("VALIDATED");
    expect(priya.ownerUserId).toBe(await userId("jennifer")); // Nursing → Jennifer
    const ravi = await prisma.candidate.findFirstOrThrow({ where: { name: "Ravi K" } });
    expect(ravi.ownerUserId).toBe(await userId("poojitha")); // Pharmacy → Poojitha
    const meera = await prisma.candidate.findFirstOrThrow({ where: { name: "Dr Meera" } });
    expect(meera.source).toBe("LINKEDIN");
    expect(meera.isNtSource).toBe(false);
    expect([await userId("mounika"), await userId("shivani")]).toContain(meera.ownerUserId);
    expect((await prisma.candidate.findFirstOrThrow({ where: { name: "No Geo" } })).stage).toBe("MAPPING");

    const rejects = await rejectsWorkbook(batch.id);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rejects as unknown as ArrayBuffer);
    expect(wb.worksheets[0].rowCount).toBe(1 + 5);
    const groups = await batchGroups(batch.id);
    expect(groups.reduce((a, g) => a + g.count, 0)).toBe(4);
  });

  it("re-importing the same file creates no duplicates", async () => {
    const buf = await xlsx(HEADERS, ROWS);
    const parsed = await parseSpreadsheet("dump.xlsx", buf);
    const mapping = autoMap(parsed.headers);
    await runImport(await as("greeshma"), { fileName: "dump.xlsx", rows: parsed.rows, mapping, source: "CONVENTIONAL_MARKETING" });
    const before = await prisma.candidate.count();
    const { counts } = await runImport(await as("greeshma"), { fileName: "dump-again.xlsx", rows: parsed.rows, mapping, source: "CONVENTIONAL_MARKETING" });
    expect(await prisma.candidate.count()).toBe(before);
    expect(counts.ACCEPTED).toBe(0);
    expect(counts.DUPLICATE_IN_DB).toBe(4);
  });

  it("parses CSV (Zoho export preset) and saves the mapping", async () => {
    const csv = 'First Name,Last Name,Mobile,Email,Current Job Title,City\n"Anil","Rao","+91 99887 76655",anil@example.com,Staff Nurse,Hyderabad\n';
    const parsed = await parseSpreadsheet("zoho.csv", Buffer.from(csv));
    const mapping = autoMap(parsed.headers, "Zoho Recruit export");
    const { counts } = await runImport(await as("greeshma"), { fileName: "zoho.csv", rows: parsed.rows, mapping, source: "OTHER", saveMappingAs: "My Zoho" });
    expect(counts.ACCEPTED).toBe(1);
    const c = await prisma.candidate.findFirstOrThrow({ where: { name: "Anil Rao" } });
    expect(c.mainCategory).toBe("NURSE");
    expect(await prisma.importMapping.count({ where: { name: "My Zoho" } })).toBe(1);
  });

  it("only permitted roles can import", async () => {
    await expect(runImport(await as("harsha"), { fileName: "x.csv", rows: [], mapping: {}, source: "OTHER" })).rejects.toThrow(/data analyst/);
  });
});
