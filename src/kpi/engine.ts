import type { PeriodType } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { getAllSettings } from "@/lib/settings";
import { periodRange } from "@contracts/shared/dates";
import { SHEETS, metricsFor, type KpiValue, type Sheet } from "./definitions";

export async function computeSheet(sheet: Sheet, start: Date, end: Date, userIds: string[] | null, db: Tx = prisma): Promise<Record<string, KpiValue>> {
  const meta = SHEETS.find((s) => s.sheet === sheet)!;
  const settings = await getAllSettings(db);
  const ctx = { db, start, end, userIds, team: meta.team, settings };
  const defs = metricsFor(sheet);
  const values: Record<string, KpiValue> = {};
  for (const d of defs) if (d.compute) values[d.key] = await d.compute(ctx);
  for (const d of defs) if (d.derive) values[d.key] = d.derive(values);
  return values;
}

export async function sheetMembers(sheet: Sheet, db: Tx = prisma) {
  const meta = SHEETS.find((s) => s.sheet === sheet)!;
  return db.user.findMany({
    where: { roles: { some: { team: { code: meta.team }, role: { in: meta.roles as never[] } } } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, active: true },
  });
}

export type SheetTable = {
  sheet: Sheet;
  title: string;
  start: Date;
  end: Date;
  members: { id: string; name: string; values: Record<string, KpiValue> }[];
  team: Record<string, KpiValue>;
};

/** Per-agent columns plus a team total (recomputed from the union of members). */
export async function computeSheetTable(sheet: Sheet, start: Date, end: Date, opts: { onlyUserId?: string } = {}, db: Tx = prisma): Promise<SheetTable> {
  const meta = SHEETS.find((s) => s.sheet === sheet)!;
  let members = await sheetMembers(sheet, db);
  if (opts.onlyUserId) members = members.filter((m) => m.id === opts.onlyUserId);
  const out: SheetTable["members"] = [];
  for (const m of members) out.push({ id: m.id, name: m.name, values: await computeSheet(sheet, start, end, [m.id], db) });
  const allIds = (await sheetMembers(sheet, db)).map((m) => m.id);
  const team = opts.onlyUserId ? {} : await computeSheet(sheet, start, end, sheet === "T4_DA" || sheet === "T4_COORD" ? null : allIds, db);
  return { sheet, title: meta.title, start, end, members: out, team };
}

export function rangeFor(periodType: PeriodType, anchor: Date) {
  return periodRange(periodType, anchor);
}
