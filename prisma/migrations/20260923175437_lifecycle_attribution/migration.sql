-- AlterEnum
ALTER TYPE "Channel" ADD VALUE 'NT_PLATFORM';

-- AlterEnum
ALTER TYPE "LeadSource" ADD VALUE 'OTHER_PORTAL';

-- AlterTable
ALTER TABLE "availability_checks" ADD COLUMN     "wasCold" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "scrutinizedAt" TIMESTAMP(3),
ADD COLUMN     "scrutinizedById" TEXT;

-- AlterTable
ALTER TABLE "lead_stage_history" ADD COLUMN     "ownerUserId" TEXT,
ADD COLUMN     "prevOwnerUserId" TEXT;

-- AlterTable
ALTER TABLE "vacancies" ADD COLUMN     "sourcerId" TEXT,
ADD COLUMN     "wasPending" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "vacancies_recruiterId_idx" ON "vacancies"("recruiterId");

-- CreateIndex
CREATE INDEX "vacancies_sourcerId_idx" ON "vacancies"("sourcerId");

-- AddForeignKey
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_sourcerId_fkey" FOREIGN KEY ("sourcerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Auto-generated candidate codes (NTC000001, ...)
CREATE SEQUENCE IF NOT EXISTS candidate_code_seq START 1;
