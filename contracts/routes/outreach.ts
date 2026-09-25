// Endpoints for the outreach domain: Team 1 queue, Team 1b missed-call inbox,
// Team 2 enrolment scrutiny and availability check-ins. See contracts/README.md.
import type { AvailabilityCheck, Candidate, Channel, ContactAttempt, ContactOutcome, LeadSource, MainCategory, MissedCall, Task, User } from "../models";
import type { MessageResult } from "../http";

// ───────────── Outreach queue ─────────────

export type QueueRow = Pick<
  Candidate,
  "id" | "name" | "candidateCode" | "mainCategory" | "jobTitle" | "currentLocation" | "mobileLast4" | "isNtSource" | "source" | "contactAttemptCount" | "nextFollowupAt"
> & {
  /** Whether the lead has an email on file (the address itself is not sent). */
  hasEmail: boolean;
  owner: Pick<User, "id" | "name"> | null;
  /** Open FOLLOW_UP / RECALL tasks (the caller's own in "mine" scope), earliest first. */
  tasks: (Pick<Task, "id" | "dueAt" | "refType" | "assigneeId" | "title"> & { assignee: Pick<User, "name"> | null })[];
  lastAttempt: Pick<ContactAttempt, "outcome" | "channel" | "at"> | null;
  /** Earliest of the first open task and the follow-up time, or null. */
  due: Date | null;
  /** The caller has an open first-time verified call allocated for this lead. */
  firstCall: boolean;
};

export interface QueueView {
  /** Effective scope; "team" is only granted to the Team 1 leader / admin. */
  scope: "mine" | "team";
  isLeader: boolean;
  canAddPortalLead: boolean;
  overdueOnly: boolean;
  page: number;
  pageSize: number;
  total: number;
  overdueCount: number;
  /** maxContactAttempts setting. */
  cap: number;
  /** Active Team 1b tele-callers (team scope only). */
  telecallers: { value: string; label: string }[];
  rows: QueueRow[];
}

/** Decrypted contact details for dialling (every read is written to the access log). */
export type LeadCallView = Pick<Candidate, "id" | "name" | "candidateCode" | "stage" | "isCold"> & {
  mobile: string | null;
  altMobile: string | null;
  email: string | null;
};

// ───────────── Missed-call inbox ─────────────

export type MissedCallRow = Omit<MissedCall, "fromMobileEnc" | "fromMobileHash"> & {
  lead: Pick<Candidate, "id" | "name" | "candidateCode" | "stage" | "isCold"> | null;
  /** Assignee's name (leaders only). */
  assigneeName: string | null;
  /** Due time of the earliest open recall task. */
  recallDue: Date | null;
};

export interface MissedCallInbox {
  isLeader: boolean;
  tab: "open" | "closed";
  page: number;
  pageSize: number;
  total: number;
  openCount: number;
  /** This IST week's funnel (own, or whole team for leaders). */
  funnel: { missed: number; recalled: number; answered: number; linkSent: number; enrolled: number };
  calls: MissedCallRow[];
}

export interface MissedCallView {
  id: string;
  receivedAt: Date;
  /** Decrypted caller number. */
  mobile: string;
  lead: Pick<Candidate, "id" | "name" | "candidateCode"> | null;
}

// ───────────── Availability check-ins ─────────────

export type AvailabilityLead = Pick<Candidate, "id" | "name" | "candidateCode" | "mainCategory" | "stage" | "isCold" | "coldSince" | "stageChangedAt"> & {
  owner: Pick<User, "name"> | null;
  lastCheck: Pick<AvailabilityCheck, "checkedAt" | "available" | "notes"> | null;
  /** Next pending scheduled check-in job. */
  nextCheckAt: Date | null;
};

export interface AvailabilityView {
  isLeader: boolean;
  coldOnly: boolean;
  page: number;
  pageSize: number;
  /** availabilityCheckIntervalDays setting. */
  interval: number;
  weekStart: Date;
  monthStart: Date;
  dueTasks: (Pick<Task, "id" | "dueAt"> & { candidate: AvailabilityLead })[];
  qualified: AvailabilityLead[];
  qualifiedTotal: number;
  coldCount: number;
  convWeek: number;
  convMonth: number;
  recent: (Pick<AvailabilityCheck, "id" | "checkedAt" | "notes" | "byUserId"> & {
    candidate: Pick<Candidate, "id" | "name" | "candidateCode" | "stage" | "isCold">;
    byName: string | null;
  })[];
}

// ───────────── Enrolment scrutiny ─────────────

export type ScrutinyTab = "incomplete" | "complete" | "all";

export type ScrutinyRow = Pick<Candidate, "id" | "name" | "candidateCode" | "mainCategory" | "enrolledAt" | "stageChangedAt" | "scrutinizedAt" | "scrutinizedById" | "tlRemarks"> & {
  owner: Pick<User, "name"> | null;
  /** Mandatory SOP field keys that are empty. */
  missing: string[];
  pct: number;
  scrutinizerName: string | null;
  /** Earliest open COLLECT_DETAILS task. */
  task: (Pick<Task, "dueAt"> & { assignee: Pick<User, "name"> | null }) | null;
};

export interface ScrutinyView {
  isLeader: boolean;
  tab: ScrutinyTab;
  page: number;
  pageSize: number;
  counts: Record<ScrutinyTab, number>;
  total: number;
  mandatory: string[];
  leads: ScrutinyRow[];
}

export interface OutreachRoutes {
  "GET /v1/queue": { query?: { scope?: "mine" | "team"; overdue?: boolean; page?: number }; response: QueueView };
  "GET /v1/queue/{id}/call": { params: { id: string }; response: LeadCallView };
  "POST /v1/queue/{id}/contact": {
    params: { id: string };
    body: { channel: Channel; outcome: ContactOutcome; notes?: string; firstCall?: boolean };
    response: MessageResult;
  };
  "POST /v1/queue/{id}/enrolment-link": { params: { id: string }; body: { channel: "WHATSAPP" | "SMS" | "EMAIL" }; response: MessageResult };
  "POST /v1/queue/allocate": { body: { ids: string[]; telecallerId: string }; response: MessageResult };
  "POST /v1/queue/portal-leads": {
    body: { name: string; mobile: string; source: LeadSource; mainCategory?: MainCategory; currentLocation?: string; jobTitle?: string };
    response: MessageResult;
  };

  "GET /v1/missed-calls": { query?: { tab?: "open" | "closed"; page?: number }; response: MissedCallInbox };
  "POST /v1/missed-calls": { body: { mobile: string; receivedAt?: Date; notes?: string }; response: MessageResult };
  "GET /v1/missed-calls/{id}/call": { params: { id: string }; response: MissedCallView };
  "POST /v1/missed-calls/{id}/recall": {
    params: { id: string };
    body: { answered?: boolean; linkSent?: boolean; enrolled?: boolean; notes?: string; name?: string; mainCategory?: MainCategory; currentLocation?: string; jobTitle?: string };
    response: MessageResult;
  };

  "GET /v1/availability": { query?: { page?: number; cold?: boolean }; response: AvailabilityView };
  "POST /v1/availability/{id}/check": { params: { id: string }; body: { available: boolean; notes?: string }; response: MessageResult };
  "POST /v1/availability/{id}/cold": { params: { id: string }; body: { cold: boolean }; response: MessageResult };

  "GET /v1/scrutiny": { query?: { tab?: ScrutinyTab; page?: number }; response: ScrutinyView };
  "POST /v1/scrutiny/{id}/scrutinize": { params: { id: string }; body: { remark?: string }; response: MessageResult };
  "POST /v1/scrutiny/{id}/verify": { params: { id: string }; body: { tlRemark?: string }; response: MessageResult };
}
