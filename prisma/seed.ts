import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
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
  // Accounts that already exist keep their password, so only accounts created by THIS run get one issued.
  const existing = new Set((await prisma.user.findMany({ select: { email: true } })).map((u) => u.email));
  await seedCore(prisma, { passwordFor });
  if (production) {
    const fresh = new Set(issued.map(([e]) => e).filter((e) => !existing.has(e)));
    console.log("✔ core seed: teams, users, routing rules, templates, presets, holidays, KPI targets, scorecard");
    console.log("Initial passwords for NEW accounts (shown once; existing accounts unchanged). Ask users to change them from Profile:");
    const out = issued.filter(([email]) => fresh.has(email));
    if (process.stdout.isTTY) for (const [email, pw] of out) console.log(`  ${email}  ${pw}`);
    else if (out.length) {
      // Non-interactive runs (CI/CD, platform release tasks) keep stdout: write an owner-only file instead.
      const file = `seed-credentials-${Date.now()}.txt`;
      writeFileSync(file, out.map(([e, p]) => `${e}  ${p}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
      console.log(`  written to ${file} (mode 0600) — distribute, then delete it`);
    }
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
