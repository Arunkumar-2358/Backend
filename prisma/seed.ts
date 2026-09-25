import { prisma } from "@/lib/db";
import { seedCore } from "@/modules/seed/core";
import { seedDemo } from "@/modules/seed/demo";

async function main() {
  await seedCore(prisma);
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
