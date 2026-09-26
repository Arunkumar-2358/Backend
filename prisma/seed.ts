import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { emailFor, seedCore } from "@/modules/seed/core";
import { seedDemo } from "@/modules/seed/demo";

// The dev password is published in this (public) repository, so production gets a unique random
// password per new account, printed once for the operator to hand out, and never gets demo data.
const production = process.env.NODE_ENV === "production";

async function main() {
  const issued: [string, string][] = [];
  const passwordFor = production
    ? (key: string) => {
        const pw = randomBytes(12).toString("base64url");
        issued.push([emailFor(key), pw]);
        return pw;
      }
    : undefined;
  await seedCore(prisma, { passwordFor });
  if (production) {
    const created = await prisma.user.findMany({ where: { email: { in: issued.map(([e]) => e) }, lastLoginAt: null }, select: { email: true } });
    const fresh = new Set(created.map((u) => u.email));
    console.log("✔ core seed: teams, users, routing rules, templates, presets, holidays, KPI targets, scorecard");
    console.log("Initial passwords for NEW accounts (shown once; existing accounts unchanged). Ask users to change them from Profile:");
    for (const [email, pw] of issued) if (fresh.has(email)) console.log(`  ${email}  ${pw}`);
    console.log("• demo data is never seeded in production");
    return;
  }
  console.log("✔ core seed: teams, users (password Nextenti@123), routing rules, templates, presets, holidays, KPI targets, scorecard");
  if (process.env.SEED_DEMO !== "0") {
    const n = await prisma.candidate.count();
    if (n === 0) {
      await seedDemo();
      console.log("✔ demo data seeded (set SEED_DEMO=0 to skip)");
    } else console.log(`• skipped demo data (${n} candidates already exist)`);
  }
}

main().finally(() => prisma.$disconnect());
