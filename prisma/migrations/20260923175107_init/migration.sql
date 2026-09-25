-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'data_analyst', 'ta_lead', 'team1_leader', 'telecaller', 'sourcer', 'team2_leader', 'recruiter', 'team3_leader', 'ta_coordinator');

-- CreateEnum
CREATE TYPE "TeamCode" AS ENUM ('T1A', 'T1B', 'T2', 'T3A', 'T3B', 'T3C', 'T4');

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('MAPPING', 'VALIDATED', 'ENROLLED', 'QUALIFIED', 'ACTIVE', 'SOURCED', 'SELECTED', 'JOINED', 'SUCCESSFUL', 'NOT_INTERESTED', 'UNREACHABLE', 'DUPLICATE', 'INVALID', 'DROPPED');

-- CreateEnum
CREATE TYPE "DropReason" AS ENUM ('INTERVIEW_NO_SHOW', 'REJECTED', 'OFFER_DECLINED', 'LEFT_BEFORE_30_DAYS', 'NOT_JOINED', 'OTHER');

-- CreateEnum
CREATE TYPE "MainCategory" AS ENUM ('DOCTOR', 'NURSE', 'PHARMACY', 'ALLIED', 'ADMIN', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('CONVENTIONAL_MARKETING', 'NT', 'NAUKRI', 'LINKEDIN', 'INDEED', 'REFERRAL', 'DIGITAL_MARKETING', 'OTHER');

-- CreateEnum
CREATE TYPE "EmploymentPreference" AS ENUM ('FULL_TIME', 'PART_TIME', 'LOCUM', 'CONTRACT');

-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('IMMEDIATE', 'SERVING_NOTICE', 'NOT_LOOKING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ShiftPreference" AS ENUM ('DAY', 'NIGHT', 'ROTATIONAL', 'ANY');

-- CreateEnum
CREATE TYPE "DuplicateCheckStatus" AS ENUM ('PENDING', 'UNIQUE', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('INCOMPLETE', 'COMPLETE_VERIFIED');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('CALL', 'WHATSAPP', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "ContactDirection" AS ENUM ('OUTBOUND', 'INBOUND_MISSED', 'RECALL');

-- CreateEnum
CREATE TYPE "ContactOutcome" AS ENUM ('UNANSWERED', 'NOT_INTERESTED', 'INTERESTED_LINK_SENT_NOT_REGISTERED', 'BUSY_RECALL_REQUESTED', 'ANSWERED', 'ENROLLED');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('FOLLOW_UP', 'RECALL', 'COLLECT_DETAILS', 'AVAILABILITY_CHECK', 'INTERVIEW_REMINDER', 'OFFER_FOLLOW_UP', 'RETENTION_CHECK', 'GENERAL');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClientOrgType" AS ENUM ('GENERAL', 'EXISTING', 'FREE_TRIAL');

-- CreateEnum
CREATE TYPE "VacancyStatus" AS ENUM ('OPEN', 'PENDING', 'CLOSED');

-- CreateEnum
CREATE TYPE "SubmissionDecision" AS ENUM ('PENDING', 'SHORTLISTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InterviewMode" AS ENUM ('IN_PERSON', 'VIDEO', 'PHONE');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('SCHEDULED', 'ATTENDED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InterviewResult" AS ENUM ('PENDING', 'SELECTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RedFlagStatus" AS ENUM ('OPEN', 'CAPA_SUGGESTED', 'IMPLEMENTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('WEEK', 'MONTH');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('ACCEPTED', 'NEEDS_MAPPING', 'DUPLICATE_IN_FILE', 'DUPLICATE_IN_DB', 'INVALID_MOBILE', 'ERROR');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "DeletionRequestStatus" AS ENUM ('REQUESTED', 'COMPLETED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "code" "TeamCode" NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_team_roles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "category" "MainCategory",

    CONSTRAINT "user_team_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_rules" (
    "id" TEXT NOT NULL,
    "teamCode" "TeamCode" NOT NULL,
    "category" "MainCategory",
    "userId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "assignment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "candidateCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobileEnc" TEXT NOT NULL,
    "mobileHash" TEXT NOT NULL,
    "mobileLast4" TEXT NOT NULL,
    "altMobileEnc" TEXT,
    "emailEnc" TEXT,
    "emailHash" TEXT,
    "basicQualification" TEXT,
    "additionalQualifications" TEXT[],
    "registrationNumber" TEXT,
    "registrationAuthority" TEXT,
    "registrationYear" INTEGER,
    "mainCategory" "MainCategory",
    "professionFunctionalHead" TEXT,
    "jobTitle" TEXT,
    "primarySpecialty" TEXT,
    "secondarySkills" TEXT[],
    "experienceYears" DOUBLE PRECISION,
    "currentOrg" TEXT,
    "currentDesignation" TEXT,
    "currentLocation" TEXT,
    "preferredLocations" TEXT[],
    "currentCtcLakhs" DOUBLE PRECISION,
    "expectedCtcLakhs" DOUBLE PRECISION,
    "noticePeriodDays" INTEGER,
    "earliestAvailabilityDate" TIMESTAMP(3),
    "availabilityStatus" "AvailabilityStatus" NOT NULL DEFAULT 'UNKNOWN',
    "shiftPreference" "ShiftPreference",
    "employmentPreference" "EmploymentPreference",
    "source" "LeadSource" NOT NULL DEFAULT 'OTHER',
    "isNtSource" BOOLEAN NOT NULL DEFAULT false,
    "resumeFileKey" TEXT,
    "resumeFileName" TEXT,
    "introVideoKey" TEXT,
    "consentRecordStoreShare" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "anonymizedAt" TIMESTAMP(3),
    "ownerUserId" TEXT,
    "stage" "Stage" NOT NULL DEFAULT 'MAPPING',
    "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isCold" BOOLEAN NOT NULL DEFAULT false,
    "coldSince" TIMESTAMP(3),
    "dropReason" "DropReason",
    "duplicateCheckStatus" "DuplicateCheckStatus" NOT NULL DEFAULT 'PENDING',
    "profileCompletenessPct" INTEGER NOT NULL DEFAULT 0,
    "tlRemarks" TEXT,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'INCOMPLETE',
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "contactAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextFollowupAt" TIMESTAMP(3),
    "importBatchId" TEXT,
    "enrolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_stage_history" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "fromStage" "Stage",
    "toStage" "Stage" NOT NULL,
    "byUserId" TEXT,
    "bySystem" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "lead_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_attempts" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "direction" "ContactDirection" NOT NULL DEFAULT 'OUTBOUND',
    "outcome" "ContactOutcome" NOT NULL,
    "isFirstTimeVerifiedCall" BOOLEAN NOT NULL DEFAULT false,
    "linkSent" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "nextFollowupAt" TIMESTAMP(3),
    "byUserId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missed_calls" (
    "id" TEXT NOT NULL,
    "fromMobileEnc" TEXT NOT NULL,
    "fromMobileHash" TEXT NOT NULL,
    "fromLast4" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "candidateId" TEXT,
    "assignedToId" TEXT,
    "recallAttemptedAt" TIMESTAMP(3),
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "linkSent" BOOLEAN NOT NULL DEFAULT false,
    "enrolled" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "missed_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "type" "TaskType" NOT NULL,
    "title" TEXT NOT NULL,
    "candidateId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "assigneeId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "result" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_checks" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available" BOOLEAN NOT NULL,
    "byUserId" TEXT,
    "notes" TEXT,

    CONSTRAINT "availability_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileKey" TEXT,
    "mappingName" TEXT,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PROCESSING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "acceptedRows" INTEGER NOT NULL DEFAULT 0,
    "needsMappingRows" INTEGER NOT NULL DEFAULT 0,
    "source" "LeadSource" NOT NULL DEFAULT 'OTHER',
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "rejectionReason" TEXT,
    "candidateId" TEXT,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_mappings" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "isPreset" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_orgs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ClientOrgType" NOT NULL DEFAULT 'GENERAL',
    "city" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_orgs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vacancies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "MainCategory" NOT NULL,
    "specialty" TEXT,
    "location" TEXT NOT NULL,
    "minExperienceYears" DOUBLE PRECISION,
    "ctcMinLakhs" DOUBLE PRECISION,
    "ctcMaxLakhs" DOUBLE PRECISION,
    "maxNoticeDays" INTEGER,
    "openings" INTEGER NOT NULL DEFAULT 1,
    "openingsFilled" INTEGER NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calibratedAt" TIMESTAMP(3),
    "status" "VacancyStatus" NOT NULL DEFAULT 'OPEN',
    "addedBefore2pm" BOOLEAN NOT NULL DEFAULT false,
    "routedTeam" "TeamCode" NOT NULL,
    "recruiterId" TEXT,
    "sourcingCompletedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vacancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" TEXT NOT NULL,
    "vacancyId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "isNtSource" BOOLEAN NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchScore" DOUBLE PRECISION,
    "decision" "SubmissionDecision" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "mode" "InterviewMode" NOT NULL DEFAULT 'IN_PERSON',
    "communicatedAt" TIMESTAMP(3),
    "status" "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "result" "InterviewResult" NOT NULL DEFAULT 'PENDING',
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "attended" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "joiningDate" TIMESTAMP(3),
    "ctcLakhs" DOUBLE PRECISION,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "joinings" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL,
    "formalitiesCompletedAt" TIMESTAMP(3),
    "retained7dAt" TIMESTAMP(3),
    "retained30dAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "joinings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_criteria" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "weightPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "eval_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluations" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "vacancyId" TEXT,
    "interviewId" TEXT,
    "templateId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_candidates" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,

    CONSTRAINT "evaluation_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_scores" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "net" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "eval_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "red_flags" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "teamCode" "TeamCode" NOT NULL,
    "description" TEXT NOT NULL,
    "agentId" TEXT,
    "kpiKey" TEXT,
    "kpiDeviated" TEXT,
    "targetStandard" TEXT,
    "actual" TEXT,
    "raisedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raisedById" TEXT,
    "autoRaised" BOOLEAN NOT NULL DEFAULT false,
    "periodType" "PeriodType",
    "periodStart" TIMESTAMP(3),
    "capaSuggested" TEXT,
    "capaSuggestedAt" TIMESTAMP(3),
    "expectedOutcome" TEXT,
    "dueDate" TIMESTAMP(3),
    "completionDate" TIMESTAMP(3),
    "actionOwnerId" TEXT,
    "correctiveActionImplemented" TEXT,
    "implementedAt" TIMESTAMP(3),
    "achievedOutcome" TEXT,
    "status" "RedFlagStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedWithin1WorkingDay" BOOLEAN,
    "dedupeKey" TEXT,

    CONSTRAINT "red_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_targets" (
    "id" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "teamCode" "TeamCode" NOT NULL,
    "periodType" "PeriodType" NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "comparator" TEXT NOT NULL DEFAULT 'gte',

    CONSTRAINT "kpi_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_snapshots" (
    "id" TEXT NOT NULL,
    "teamCode" "TeamCode" NOT NULL,
    "userId" TEXT,
    "periodType" "PeriodType" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "metricKey" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kpi_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "present" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT,
    "channel" "Channel" NOT NULL,
    "toAddress" TEXT NOT NULL,
    "templateKey" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "sentById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "diff" JSONB,
    "ip" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_deletion_requests" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedVia" TEXT,
    "reason" TEXT,
    "status" "DeletionRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "processedAt" TIMESTAMP(3),
    "processedById" TEXT,

    CONSTRAINT "data_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "teams_code_key" ON "teams"("code");

-- CreateIndex
CREATE UNIQUE INDEX "user_team_roles_userId_teamId_role_key" ON "user_team_roles"("userId", "teamId", "role");

-- CreateIndex
CREATE INDEX "assignment_rules_teamCode_category_idx" ON "assignment_rules"("teamCode", "category");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_candidateCode_key" ON "candidates"("candidateCode");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_mobileHash_key" ON "candidates"("mobileHash");

-- CreateIndex
CREATE INDEX "candidates_stage_idx" ON "candidates"("stage");

-- CreateIndex
CREATE INDEX "candidates_ownerUserId_idx" ON "candidates"("ownerUserId");

-- CreateIndex
CREATE INDEX "candidates_mainCategory_idx" ON "candidates"("mainCategory");

-- CreateIndex
CREATE INDEX "candidates_emailHash_idx" ON "candidates"("emailHash");

-- CreateIndex
CREATE INDEX "candidates_stage_ownerUserId_idx" ON "candidates"("stage", "ownerUserId");

-- CreateIndex
CREATE INDEX "candidates_stage_mainCategory_idx" ON "candidates"("stage", "mainCategory");

-- CreateIndex
CREATE INDEX "candidates_nextFollowupAt_idx" ON "candidates"("nextFollowupAt");

-- CreateIndex
CREATE INDEX "lead_stage_history_candidateId_at_idx" ON "lead_stage_history"("candidateId", "at");

-- CreateIndex
CREATE INDEX "lead_stage_history_toStage_at_idx" ON "lead_stage_history"("toStage", "at");

-- CreateIndex
CREATE INDEX "contact_attempts_candidateId_at_idx" ON "contact_attempts"("candidateId", "at");

-- CreateIndex
CREATE INDEX "contact_attempts_byUserId_at_idx" ON "contact_attempts"("byUserId", "at");

-- CreateIndex
CREATE INDEX "missed_calls_receivedAt_idx" ON "missed_calls"("receivedAt");

-- CreateIndex
CREATE INDEX "missed_calls_assignedToId_idx" ON "missed_calls"("assignedToId");

-- CreateIndex
CREATE INDEX "tasks_assigneeId_status_dueAt_idx" ON "tasks"("assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_candidateId_status_idx" ON "tasks"("candidateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_jobs_dedupeKey_key" ON "scheduled_jobs"("dedupeKey");

-- CreateIndex
CREATE INDEX "scheduled_jobs_status_runAt_idx" ON "scheduled_jobs"("status", "runAt");

-- CreateIndex
CREATE INDEX "availability_checks_candidateId_checkedAt_idx" ON "availability_checks"("candidateId", "checkedAt");

-- CreateIndex
CREATE INDEX "import_rows_batchId_status_idx" ON "import_rows"("batchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_mappings_name_key" ON "import_mappings"("name");

-- CreateIndex
CREATE UNIQUE INDEX "client_orgs_name_key" ON "client_orgs"("name");

-- CreateIndex
CREATE UNIQUE INDEX "vacancies_code_key" ON "vacancies"("code");

-- CreateIndex
CREATE INDEX "vacancies_status_category_idx" ON "vacancies"("status", "category");

-- CreateIndex
CREATE INDEX "vacancies_routedTeam_status_idx" ON "vacancies"("routedTeam", "status");

-- CreateIndex
CREATE INDEX "submissions_submittedAt_idx" ON "submissions"("submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_vacancyId_candidateId_key" ON "submissions"("vacancyId", "candidateId");

-- CreateIndex
CREATE INDEX "interviews_scheduledAt_idx" ON "interviews"("scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "joinings_offerId_key" ON "joinings"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "eval_templates_name_key" ON "eval_templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_candidates_evaluationId_slot_key" ON "evaluation_candidates"("evaluationId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_candidates_evaluationId_candidateId_key" ON "evaluation_candidates"("evaluationId", "candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "eval_scores_evaluationId_criterionId_candidateId_key" ON "eval_scores"("evaluationId", "criterionId", "candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "red_flags_dedupeKey_key" ON "red_flags"("dedupeKey");

-- CreateIndex
CREATE INDEX "red_flags_teamCode_status_idx" ON "red_flags"("teamCode", "status");

-- CreateIndex
CREATE INDEX "red_flags_raisedOn_idx" ON "red_flags"("raisedOn");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_date_key" ON "holidays"("date");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_targets_metricKey_teamCode_periodType_key" ON "kpi_targets"("metricKey", "teamCode", "periodType");

-- CreateIndex
CREATE INDEX "kpi_snapshots_periodType_periodStart_idx" ON "kpi_snapshots"("periodType", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_snapshots_teamCode_userId_periodType_periodStart_metric_key" ON "kpi_snapshots"("teamCode", "userId", "periodType", "periodStart", "metricKey");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_userId_date_key" ON "attendance"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_key_key" ON "message_templates"("key");

-- CreateIndex
CREATE INDEX "messages_candidateId_createdAt_idx" ON "messages"("candidateId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_entityType_entityId_at_idx" ON "audit_log"("entityType", "entityId", "at");

-- CreateIndex
CREATE INDEX "audit_log_actorId_at_idx" ON "audit_log"("actorId", "at");

-- CreateIndex
CREATE INDEX "audit_log_action_at_idx" ON "audit_log"("action", "at");

-- AddForeignKey
ALTER TABLE "user_team_roles" ADD CONSTRAINT "user_team_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_team_roles" ADD CONSTRAINT "user_team_roles_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_attempts" ADD CONSTRAINT "contact_attempts_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_attempts" ADD CONSTRAINT "contact_attempts_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_checks" ADD CONSTRAINT "availability_checks_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_clientOrgId_fkey" FOREIGN KEY ("clientOrgId") REFERENCES "client_orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_vacancyId_fkey" FOREIGN KEY ("vacancyId") REFERENCES "vacancies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "joinings" ADD CONSTRAINT "joinings_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_criteria" ADD CONSTRAINT "eval_criteria_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "eval_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_criteria" ADD CONSTRAINT "eval_criteria_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "eval_criteria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_vacancyId_fkey" FOREIGN KEY ("vacancyId") REFERENCES "vacancies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "eval_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_candidates" ADD CONSTRAINT "evaluation_candidates_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_candidates" ADD CONSTRAINT "evaluation_candidates_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_scores" ADD CONSTRAINT "eval_scores_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_scores" ADD CONSTRAINT "eval_scores_criterionId_fkey" FOREIGN KEY ("criterionId") REFERENCES "eval_criteria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_scores" ADD CONSTRAINT "eval_scores_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "red_flags" ADD CONSTRAINT "red_flags_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "red_flags" ADD CONSTRAINT "red_flags_actionOwnerId_fkey" FOREIGN KEY ("actionOwnerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "red_flags" ADD CONSTRAINT "red_flags_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
