/**
 * Performance check (PLAN Phase 7): bulk-load N candidates and time the hot
 * queries behind the lead list, queue, dedupe and dashboards.
 *   DATABASE_URL=…/recruit_crm_perf npx tsx scripts/perf-check.ts 100000
 */
import { prisma } from "@/lib/db";
import { encrypt, blindIndex } from "@/lib/crypto";
import { seedCore } from "@/modules/seed/core";
import type { MainCategory, Stage } from "@prisma/client";

const N = Number(process.argv[2] ?? 100_000);
const STAGES: Stage[] = ["VALIDATED", "VALIDATED", "VALIDATED", "ENROLLED", "QUALIFIED", "ACTIVE", "SOURCED", "NOT_INTERESTED", "UNREACHABLE"];
const CATS: MainCategory[] = ["NURSE", "NURSE", "PHARMACY", "DOCTOR", "ALLIED", "OTHER"];

async function time<T>(label: string, fn: () => Promise<T>) {
  const t = performance.now();
  const r = await fn();
  console.log(`${label.padEnd(58)} ${(performance.now() - t).toFixed(1).padStart(8)} ms`);
  return r;
}

async function main() {
  await seedCore(prisma, { fastHash: true });
  const users = await prisma.user.findMany();
  const existing = await prisma.candidate.count();
  if (existing < N) {
    console.log(`Loading ${N - existing} candidates…`);
    const t = performance.now();
    for (let off = existing; off < N; off += 5000) {
      const batch = [];
      for (let i = off; i < Math.min(N, off + 5000); i++) {
        const mobile = String(6000000000 + i);
        batch.push({
          candidateCode: `PRF${String(i).padStart(7, "0")}`,
          name: `Perf Candidate ${i}`,
          mobileEnc: encrypt(mobile),
          mobileHash: blindIndex(mobile),
          mobileLast4: mobile.slice(-4),
          emailEnc: encrypt(`p${i}@example.com`),
          emailHash: blindIndex(`p${i}@example.com`),
          mainCategory: CATS[i % CATS.length],
          stage: STAGES[i % STAGES.length],
          ownerUserId: users[i % users.length].id,
          currentLocation: ["Hyderabad", "Chennai", "Bengaluru"][i % 3],
          preferredLocations: ["Hyderabad"],
          experienceYears: i % 12,
          profileCompletenessPct: 60 + (i % 5) * 10,
          duplicateCheckStatus: "UNIQUE" as const,
          nextFollowupAt: new Date(Date.now() + (i % 100) * 3600_000),
        });
      }
      await prisma.candidate.createMany({ data: batch });
    }
    console.log(`Loaded in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  }
  await prisma.$executeRawUnsafe("ANALYZE candidates");
  const owner = users[3].id;
  console.log(`\n${await prisma.candidate.count()} candidates\n`);
  await time("Lead list: owner + stage, page 1 (50) ordered by follow-up", () => prisma.candidate.findMany({ where: { ownerUserId: owner, stage: "VALIDATED" }, orderBy: { nextFollowupAt: "asc" }, take: 50 }));
  await time("Lead list: stage + category, page 20 (offset 950)", () => prisma.candidate.findMany({ where: { stage: "ACTIVE", mainCategory: "NURSE" }, orderBy: { createdAt: "desc" }, skip: 950, take: 50 }));
  await time("Count by stage (Kanban header)", () => prisma.candidate.groupBy({ by: ["stage"], _count: true }));
  await time("Dedupe lookup by mobile blind index", () => prisma.candidate.findUnique({ where: { mobileHash: blindIndex("6000054321") } }));
  await time("Dedupe lookup by email blind index", () => prisma.candidate.findFirst({ where: { emailHash: blindIndex("p77777@example.com") } }));
  await time("Search by last-4 digits", () => prisma.candidate.findMany({ where: { mobileLast4: "4321" }, take: 50 }));
  await time("Name search (ILIKE contains)", () => prisma.candidate.findMany({ where: { name: { contains: "Candidate 9999", mode: "insensitive" } }, take: 50 }));
  await time("Active nurses pool for matching (take 2000)", () => prisma.candidate.findMany({ where: { stage: "ACTIVE", mainCategory: "NURSE" }, take: 2000 }));
  await prisma.$disconnect();
}

main();
