import { prisma } from "@/lib/db";
import { loadActor } from "@/lib/actor";
import { setClock } from "@/lib/clock";
import type { Actor } from "@/lib/rbac";
import { seedCore, emailFor } from "@/modules/seed/core";
import { setAdapters, MemoryAdapter } from "@/modules/messaging/adapters";
import { createCandidate, type CandidateInput } from "@/modules/candidates/service";
import { SYSTEM } from "@/lib/rbac";

export const memory = new MemoryAdapter();

export async function resetDb() {
  setClock(null);
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE candidate_code_seq RESTART WITH 1`);
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE vacancy_code_seq RESTART WITH 1`);
  memory.sent = [];
  setAdapters({ WHATSAPP: memory, SMS: memory, EMAIL: memory, CALL: memory });
  return seedCore(prisma, { fastHash: true });
}

export async function as(key: string): Promise<Actor> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email: emailFor(key) } });
  return (await loadActor(u.id))!;
}

export async function userId(key: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { email: emailFor(key) } })).id;
}

let mobileSeq = 9000000000;
export function nextMobile() {
  mobileSeq += 1;
  return String(mobileSeq);
}

/** A fully-complete profile (all mandatory SOP fields). */
export function completeProfile(overrides: CandidateInput = {}): CandidateInput & { name: string; mobile: string } {
  return {
    name: "Asha Kumari",
    mobile: nextMobile(),
    email: `asha${mobileSeq}@example.com`,
    basicQualification: "B.Sc Nursing",
    registrationNumber: "TNNMC-12345",
    mainCategory: "NURSE",
    jobTitle: "Staff Nurse",
    primarySpecialty: "ICU",
    experienceYears: 4,
    currentLocation: "Hyderabad",
    preferredLocations: ["Hyderabad", "Bengaluru"],
    currentCtcLakhs: 3.6,
    expectedCtcLakhs: 4.5,
    noticePeriodDays: 30,
    resumeFileKey: "resumes/test.pdf",
    consentRecordStoreShare: true,
    source: "CONVENTIONAL_MARKETING",
    ...overrides,
  } as CandidateInput & { name: string; mobile: string };
}

/** Create a lead in MAPPING via the service (as the import would). */
export async function newLead(overrides: CandidateInput = {}) {
  return createCandidate(SYSTEM("test"), completeProfile(overrides));
}

export async function stageOf(id: string) {
  return (await prisma.candidate.findUniqueOrThrow({ where: { id } })).stage;
}
