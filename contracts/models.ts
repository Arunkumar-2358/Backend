// Generated from prisma/schema.prisma by `npm run db:generate`. Do not edit.

export type Role = "admin" | "data_analyst" | "ta_lead" | "team1_leader" | "telecaller" | "sourcer" | "team2_leader" | "recruiter" | "team3_leader" | "ta_coordinator";

export type TeamCode = "T1A" | "T1B" | "T2" | "T3A" | "T3B" | "T3C" | "T4";

export type Stage = "MAPPING" | "VALIDATED" | "ENROLLED" | "QUALIFIED" | "ACTIVE" | "SOURCED" | "SELECTED" | "JOINED" | "SUCCESSFUL" | "NOT_INTERESTED" | "UNREACHABLE" | "DUPLICATE" | "INVALID" | "DROPPED";

export type DropReason = "INTERVIEW_NO_SHOW" | "REJECTED" | "OFFER_DECLINED" | "LEFT_BEFORE_30_DAYS" | "NOT_JOINED" | "OTHER";

export type MainCategory = "DOCTOR" | "NURSE" | "PHARMACY" | "ALLIED" | "ADMIN" | "OTHER";

/**
 * Engagement of an enrolled + qualified lead, from how recently they were last active on the NT platform
 * (or confirmed they need a job). Derived from candidates.last_engaged_at; see contracts/shared/engagement.ts.
 */
export type EngagementTier = "SUPER_ACTIVE" | "ACTIVE" | "WARM" | "COLD";

/**
 * What a candidate's reply to the cold-lead re-engagement WhatsApp says about their job need.
 */
export type JobIntent = "LOOKING" | "NOT_LOOKING" | "UNCLEAR";

export type LeadSource = "CONVENTIONAL_MARKETING" | "NT" | "NAUKRI" | "LINKEDIN" | "INDEED" | "REFERRAL" | "DIGITAL_MARKETING" | "OTHER_PORTAL" | "OTHER";

export type EmploymentPreference = "FULL_TIME" | "PART_TIME" | "LOCUM" | "CONTRACT";

export type AvailabilityStatus = "IMMEDIATE" | "SERVING_NOTICE" | "NOT_LOOKING" | "UNKNOWN";

export type ShiftPreference = "DAY" | "NIGHT" | "ROTATIONAL" | "ANY";

export type DuplicateCheckStatus = "PENDING" | "UNIQUE" | "DUPLICATE";

export type VerificationStatus = "INCOMPLETE" | "COMPLETE_VERIFIED";

export type Channel = "CALL" | "WHATSAPP" | "SMS" | "EMAIL" | "NT_PLATFORM";

export type ContactDirection = "OUTBOUND" | "INBOUND_MISSED" | "RECALL";

export type ContactOutcome = "UNANSWERED" | "NOT_INTERESTED" | "INTERESTED_LINK_SENT_NOT_REGISTERED" | "BUSY_RECALL_REQUESTED" | "ANSWERED" | "ENROLLED" | "NEEDS_JOB";

export type TaskType = "FOLLOW_UP" | "RECALL" | "COLLECT_DETAILS" | "AVAILABILITY_CHECK" | "INTERVIEW_REMINDER" | "OFFER_FOLLOW_UP" | "RETENTION_CHECK" | "REENGAGE_REPLY" | "COLD_CALL" | "GENERAL";

export type TaskStatus = "OPEN" | "DONE" | "CANCELLED";

export type JobStatus = "PENDING" | "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

export type ClientOrgType = "GENERAL" | "EXISTING" | "FREE_TRIAL";

export type VacancyStatus = "OPEN" | "PENDING" | "CLOSED";

export type SubmissionDecision = "PENDING" | "SHORTLISTED" | "REJECTED";

export type InterviewMode = "IN_PERSON" | "VIDEO" | "PHONE";

export type InterviewStatus = "SCHEDULED" | "ATTENDED" | "NO_SHOW" | "CANCELLED";

export type InterviewResult = "PENDING" | "SELECTED" | "REJECTED";

export type RedFlagStatus = "OPEN" | "CAPA_SUGGESTED" | "IMPLEMENTED" | "CLOSED";

export type PeriodType = "WEEK" | "MONTH";

export type ImportBatchStatus = "PROCESSING" | "COMPLETED" | "FAILED";

export type ImportRowStatus = "ACCEPTED" | "NEEDS_MAPPING" | "DUPLICATE_IN_FILE" | "DUPLICATE_IN_DB" | "INVALID_MOBILE" | "ERROR";

export type MessageStatus = "QUEUED" | "SENT" | "FAILED";

export type DeletionRequestStatus = "REQUESTED" | "COMPLETED" | "REJECTED";

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  active: boolean;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  /**
   * UI theme preference: "light" | "dark" | "system" (follow the device)
   */
  theme: string;
}

export interface Team {
  id: string;
  code: TeamCode;
  name: string;
}

export interface UserTeamRole {
  id: string;
  userId: string;
  teamId: string;
  role: Role;
  category: MainCategory | null;
}

/**
 * Configurable routing: which user receives a lead of a category when it enters a team.
 */
export interface AssignmentRule {
  id: string;
  teamCode: TeamCode;
  category: MainCategory | null;
  userId: string;
  priority: number;
  active: boolean;
}

export interface Candidate {
  id: string;
  candidateCode: string;
  name: string;
  mobileEnc: string;
  mobileHash: string;
  mobileLast4: string;
  altMobileEnc: string | null;
  emailEnc: string | null;
  emailHash: string | null;
  basicQualification: string | null;
  additionalQualifications: string[];
  registrationNumber: string | null;
  registrationAuthority: string | null;
  registrationYear: number | null;
  mainCategory: MainCategory | null;
  professionFunctionalHead: string | null;
  jobTitle: string | null;
  primarySpecialty: string | null;
  secondarySkills: string[];
  experienceYears: number | null;
  currentOrg: string | null;
  currentDesignation: string | null;
  currentLocation: string | null;
  preferredLocations: string[];
  currentCtcLakhs: number | null;
  expectedCtcLakhs: number | null;
  noticePeriodDays: number | null;
  earliestAvailabilityDate: Date | null;
  availabilityStatus: AvailabilityStatus;
  shiftPreference: ShiftPreference | null;
  employmentPreference: EmploymentPreference | null;
  source: LeadSource;
  isNtSource: boolean;
  resumeFileKey: string | null;
  resumeFileName: string | null;
  introVideoKey: string | null;
  consentRecordStoreShare: boolean;
  consentAt: Date | null;
  anonymizedAt: Date | null;
  ownerUserId: string | null;
  stage: Stage;
  stageChangedAt: Date;
  isCold: boolean;
  coldSince: Date | null;
  dropReason: DropReason | null;
  duplicateCheckStatus: DuplicateCheckStatus;
  profileCompletenessPct: number;
  tlRemarks: string | null;
  verificationStatus: VerificationStatus;
  verifiedById: string | null;
  verifiedAt: Date | null;
  contactAttemptCount: number;
  nextFollowupAt: Date | null;
  importBatchId: string | null;
  enrolledAt: Date | null;
  scrutinizedAt: Date | null;
  scrutinizedById: string | null;
  allocatedAt: Date | null;
  allocatedById: string | null;
  lastPlatformVisitAt: Date | null;
  jobIntentAt: Date | null;
  lastEngagedAt: Date | null;
  reengageSentAt: Date | null;
  coldCallAllocatedAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  lastUpdated: Date;
}

export interface LeadStageHistory {
  id: string;
  candidateId: string;
  fromStage: Stage | null;
  toStage: Stage;
  byUserId: string | null;
  bySystem: string | null;
  prevOwnerUserId: string | null;
  ownerUserId: string | null;
  at: Date;
  note: string | null;
}

export interface ContactAttempt {
  id: string;
  candidateId: string;
  channel: Channel;
  direction: ContactDirection;
  outcome: ContactOutcome;
  isFirstTimeVerifiedCall: boolean;
  linkSent: boolean;
  /**
   * Team 2 cold-lead re-engagement call (not Team 1 outreach); direction RECALL = a re-attempt
   */
  coldCall: boolean;
  notes: string | null;
  nextFollowupAt: Date | null;
  byUserId: string | null;
  at: Date;
}

/**
 * Team 1b missed-call inbox. A missed incoming call may or may not match a known lead.
 */
export interface MissedCall {
  id: string;
  fromMobileEnc: string;
  fromMobileHash: string;
  fromLast4: string;
  receivedAt: Date;
  candidateId: string | null;
  assignedToId: string | null;
  recallAttemptedAt: Date | null;
  answered: boolean;
  linkSent: boolean;
  enrolled: boolean;
  closedAt: Date | null;
  notes: string | null;
}

export interface Task {
  id: string;
  type: TaskType;
  title: string;
  candidateId: string | null;
  refType: string | null;
  refId: string | null;
  assigneeId: string | null;
  dueAt: Date;
  status: TaskStatus;
  result: string | null;
  completedAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
}

/**
 * Durable scheduled jobs (reminders, check-ins). Run by scripts/worker.ts → runDueJobs().
 */
export interface ScheduledJob {
  id: string;
  type: string;
  runAt: Date;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  dedupeKey: string | null;
  createdAt: Date;
  queuedAt: Date | null;
  doneAt: Date | null;
}

export interface AvailabilityCheck {
  id: string;
  candidateId: string;
  checkedAt: Date;
  available: boolean;
  wasCold: boolean;
  byUserId: string | null;
  notes: string | null;
}

export interface ImportBatch {
  id: string;
  fileName: string;
  fileKey: string | null;
  mappingName: string | null;
  status: ImportBatchStatus;
  totalRows: number;
  duplicateRows: number;
  invalidRows: number;
  acceptedRows: number;
  needsMappingRows: number;
  source: LeadSource;
  uploadedById: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface ImportRow {
  id: string;
  batchId: string;
  rowNumber: number;
  raw: unknown;
  status: ImportRowStatus;
  rejectionReason: string | null;
  candidateId: string | null;
}

export interface ImportMapping {
  id: string;
  name: string;
  mapping: unknown;
  isPreset: boolean;
  createdAt: Date;
}

export interface ClientOrg {
  id: string;
  name: string;
  type: ClientOrgType;
  city: string | null;
  createdAt: Date;
}

export interface Vacancy {
  id: string;
  code: string;
  clientOrgId: string;
  title: string;
  category: MainCategory;
  specialty: string | null;
  location: string;
  minExperienceYears: number | null;
  ctcMinLakhs: number | null;
  ctcMaxLakhs: number | null;
  maxNoticeDays: number | null;
  openings: number;
  openingsFilled: number;
  postedAt: Date;
  calibratedAt: Date | null;
  status: VacancyStatus;
  addedBefore2pm: boolean;
  routedTeam: TeamCode;
  recruiterId: string | null;
  sourcerId: string | null;
  taLeadId: string | null;
  description: string | null;
  mandatoryAttributes: string | null;
  wasPending: boolean;
  sourcingCompletedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
}

export interface Submission {
  id: string;
  vacancyId: string;
  candidateId: string;
  isNtSource: boolean;
  submittedById: string | null;
  submittedAt: Date;
  matchScore: number | null;
  decision: SubmissionDecision;
  decidedAt: Date | null;
}

export interface Interview {
  id: string;
  submissionId: string;
  scheduledAt: Date;
  mode: InterviewMode;
  communicatedAt: Date | null;
  status: InterviewStatus;
  result: InterviewResult;
  remindersSent: number;
  attended: boolean;
  notes: string | null;
  createdAt: Date;
}

export interface Offer {
  id: string;
  submissionId: string;
  sentAt: Date;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  joiningDate: Date | null;
  ctcLakhs: number | null;
}

export interface Joining {
  id: string;
  offerId: string;
  joinedAt: Date;
  formalitiesCompletedAt: Date | null;
  retained7dAt: Date | null;
  retained30dAt: Date | null;
  leftAt: Date | null;
  reason: string | null;
}

export interface EvalTemplate {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A criterion with sub-criteria: parent has children; weights live on leaf rows.
 */
export interface EvalCriterion {
  id: string;
  templateId: string;
  parentId: string | null;
  name: string;
  weightPct: number;
  sortOrder: number;
}

export interface Evaluation {
  id: string;
  title: string;
  vacancyId: string | null;
  interviewId: string | null;
  templateId: string;
  createdById: string | null;
  createdAt: Date;
}

export interface EvaluationCandidate {
  id: string;
  evaluationId: string;
  candidateId: string;
  slot: number;
}

export interface EvalScore {
  id: string;
  evaluationId: string;
  criterionId: string;
  candidateId: string;
  score: number;
  net: number;
}

export interface RedFlag {
  id: string;
  date: Date;
  teamCode: TeamCode;
  description: string;
  agentId: string | null;
  kpiKey: string | null;
  kpiDeviated: string | null;
  targetStandard: string | null;
  actual: string | null;
  raisedOn: Date;
  raisedById: string | null;
  autoRaised: boolean;
  periodType: PeriodType | null;
  periodStart: Date | null;
  capaSuggested: string | null;
  capaSuggestedAt: Date | null;
  expectedOutcome: string | null;
  dueDate: Date | null;
  completionDate: Date | null;
  actionOwnerId: string | null;
  correctiveActionImplemented: string | null;
  implementedAt: Date | null;
  achievedOutcome: string | null;
  status: RedFlagStatus;
  closedAt: Date | null;
  closedWithin1WorkingDay: boolean | null;
  dedupeKey: string | null;
}

export interface Holiday {
  id: string;
  date: Date;
  name: string;
}

export interface KpiTarget {
  id: string;
  metricKey: string;
  teamCode: TeamCode;
  periodType: PeriodType;
  target: number;
  comparator: string;
}

export interface KpiSnapshot {
  id: string;
  teamCode: TeamCode;
  userId: string | null;
  periodType: PeriodType;
  periodStart: Date;
  metricKey: string;
  value: number;
  frozenAt: Date;
}

/**
 * "Working days" is the only manual KPI input (from attendance).
 */
export interface Attendance {
  id: string;
  userId: string;
  date: Date;
  present: boolean;
}

export interface MessageTemplate {
  id: string;
  key: string;
  name: string;
  channel: Channel;
  subject: string | null;
  body: string;
  active: boolean;
  updatedAt: Date;
}

export interface Message {
  id: string;
  candidateId: string | null;
  channel: Channel;
  toAddress: string;
  templateKey: string | null;
  subject: string | null;
  body: string;
  provider: string;
  providerRef: string | null;
  status: MessageStatus;
  error: string | null;
  sentById: string | null;
  createdAt: Date;
}

/**
 * Inbound WhatsApp messages (replies to the re-engagement message), from the WhatsApp Cloud webhook.
 */
export interface InboundMessage {
  id: string;
  candidateId: string | null;
  channel: Channel;
  fromLast4: string;
  body: string;
  intent: JobIntent;
  providerRef: string;
  receivedAt: Date;
}

export interface AppSetting {
  key: string;
  value: unknown;
  updatedAt: Date;
}

export interface AuditLog {
  id: string;
  at: Date;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: string;
  diff: unknown | null;
  ip: string | null;
}

export interface DataDeletionRequest {
  id: string;
  candidateId: string;
  requestedAt: Date;
  requestedVia: string | null;
  reason: string | null;
  status: DeletionRequestStatus;
  processedAt: Date | null;
  processedById: string | null;
}

/**
 * In-app notifications (bell). Created by domain events: assignments, tasks, red flags, CAPA, imports, interviews.
 */
export interface Notification {
  id: string;
  userId: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}

/**
 * Web Push subscription (PWA install). One row per browser/device the user enabled notifications on.
 */
export interface PushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

/**
 * One signed-in device. The refresh token is "<id>.<secret>"; only a SHA-256 of the secret is stored.
 * Every refresh rotates the token into a new row of the same family; presenting an already-rotated
 * token outside the grace window is treated as theft and revokes the whole family.
 */
export interface AuthSession {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
}
