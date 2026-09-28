-- AlterEnum
ALTER TYPE "ContactOutcome" ADD VALUE 'NEEDS_JOB';

-- AlterEnum
ALTER TYPE "TaskType" ADD VALUE 'COLD_CALL';

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "coldCallAllocatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "contact_attempts" ADD COLUMN     "coldCall" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "vacancies" ADD COLUMN     "description" TEXT,
ADD COLUMN     "mandatoryAttributes" TEXT,
ADD COLUMN     "taLeadId" TEXT;

-- CreateIndex
CREATE INDEX "contact_attempts_coldCall_byUserId_at_idx" ON "contact_attempts"("coldCall", "byUserId", "at");

-- CreateIndex
CREATE INDEX "vacancies_taLeadId_idx" ON "vacancies"("taLeadId");

-- AddForeignKey
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_taLeadId_fkey" FOREIGN KEY ("taLeadId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
