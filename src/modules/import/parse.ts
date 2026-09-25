import ExcelJS from "exceljs";

export type RawRow = Record<string, unknown>;

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("text" in v && typeof v.text === "string") return v.text; // hyperlink
    if ("result" in v) return (v as ExcelJS.CellFormulaValue).result ?? null;
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
    return String(v);
  }
  return v;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Parse .xlsx or .csv into header-keyed rows (first non-empty row = headers). */
export async function parseSpreadsheet(fileName: string, buf: Buffer): Promise<{ headers: string[]; rows: RawRow[] }> {
  let matrix: unknown[][];
  if (fileName.toLowerCase().endsWith(".csv")) {
    matrix = parseCsv(buf.toString("utf8").replace(/^\uFEFF/, ""));
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    matrix = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const vals: unknown[] = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellValue(r.getCell(c).value));
      matrix.push(vals);
    });
  }
  if (!matrix.length) return { headers: [], rows: [] };
  const headers = (matrix[0] as unknown[]).map((h, i) => (h === null || h === undefined || String(h).trim() === "" ? `Column ${i + 1}` : String(h).trim()));
  const rows = matrix.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r as unknown[])[i] ?? null])));
  return { headers, rows };
}
