-- CreateEnum
CREATE TYPE "EngagementTier" AS ENUM ('SUPER_ACTIVE', 'ACTIVE', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "JobIntent" AS ENUM ('LOOKING', 'NOT_LOOKING', 'UNCLEAR');

-- AlterEnum
ALTER TYPE "TaskType" ADD VALUE 'REENGAGE_REPLY';

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "allocatedAt" TIMESTAMP(3),
ADD COLUMN     "allocatedById" TEXT,
ADD COLUMN     "jobIntentAt" TIMESTAMP(3),
ADD COLUMN     "lastEngagedAt" TIMESTAMP(3),
ADD COLUMN     "lastPlatformVisitAt" TIMESTAMP(3),
ADD COLUMN     "reengageSentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "inbound_messages" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT,
    "channel" "Channel" NOT NULL,
    "fromLast4" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "intent" "JobIntent" NOT NULL,
    "providerRef" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_messages_providerRef_key" ON "inbound_messages"("providerRef");

-- CreateIndex
CREATE INDEX "inbound_messages_candidateId_receivedAt_idx" ON "inbound_messages"("candidateId", "receivedAt");

-- CreateIndex
CREATE INDEX "candidates_stage_allocatedAt_idx" ON "candidates"("stage", "allocatedAt");

-- CreateIndex
CREATE INDEX "candidates_stage_lastEngagedAt_idx" ON "candidates"("stage", "lastEngagedAt");

-- AddForeignKey
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: enrolment (registering on the NT platform) is the first engagement signal.
UPDATE "candidates" SET "lastEngagedAt" = "enrolledAt" WHERE "enrolledAt" IS NOT NULL;

-- Backfill: leads already Qualified / Active are being worked by their Team 2 owner, so they
-- count as allocated. Only leads qualified from now on wait for the Team 3 leader.
UPDATE "candidates" SET "allocatedAt" = COALESCE("verifiedAt", "stageChangedAt")
WHERE "stage" IN ('QUALIFIED', 'ACTIVE') AND "allocatedAt" IS NULL;
