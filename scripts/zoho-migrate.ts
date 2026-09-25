/**
 * One-off Zoho Recruit → Nextenti CRM migration (PLAN §7 Phase 7, §10 Q6).
 *
 *   npm run migrate:zoho -- ./exports/Candidates.csv [--source NAUKRI] [--dry-run]
 *
 * Runs the same validation pipeline as the import wizard (10-digit mobiles,
 * in-file + database dedupe, category inference, routing) in chunks, so it
 * is safe to re-run: already-migrated candidates are skipped as duplicates.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LeadSource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { SYSTEM } from "@/lib/rbac";
import { parseSpreadsheet } from "@/modules/import/parse";
import { autoMap, mapRow, runImport } from "@/modules/import/pipeline";
import { validateMobile } from "@contracts/shared/phone";

const CHUNK = 2000;

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("Usage: npm run migrate:zoho -- <export.csv|xlsx> [--source X] [--dry-run]");
  const source = (args[args.indexOf("--source") + 1] as LeadSource) ?? "OTHER";
  const dry = args.includes("--dry-run");
  const { headers, rows } = await parseSpreadsheet(file, await readFile(file));
  const mapping = autoMap(headers, "Zoho Recruit export");
  console.log(`Parsed ${rows.length} rows. Mapping:`, Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)));
  if (dry) {
    const bad = rows.filter((r) => !validateMobile(mapRow(r, mapping, source).mobile).ok).length;
    console.log(`Dry run: ${rows.length - bad} rows with valid mobiles, ${bad} would be rejected.`);
    return;
  }
  const totals: Record<string, number> = {};
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { counts, batch } = await runImport(SYSTEM("zoho-migration"), { fileName: `${path.basename(file)} [${i + 1}-${i + chunk.length}]`, rows: chunk, mapping, source });
    for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + v;
    console.log(`Batch ${batch.id}: ${JSON.stringify(counts)}`);
  }
  console.log("Done:", totals);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
