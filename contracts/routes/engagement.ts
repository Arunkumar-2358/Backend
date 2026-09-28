// Endpoints for Team 3 → Team 2 allocation of qualified leads, and lead engagement
// (super active / active / warm / cold, with the cold-lead WhatsApp). See contracts/README.md.
import type { Candidate, ContactAttempt, EngagementTier, InboundMessage, MainCategory, Task, User } from "../models";
import type { MessageResult } from "../http";
import type { EngagementTierDays } from "../shared/engagement";
import type { LeadCallView } from "./outreach";

// ───────────── Allocation (Team 3 leader) ─────────────

export type AllocationLead = Pick<
  Candidate,
  "id" | "name" | "candidateCode" | "mainCategory" | "primarySpecialty" | "jobTitle" | "currentLocation" | "experienceYears" | "stageChangedAt" | "lastEngagedAt"
> & {
  tier: EngagementTier;
  /** Team 2 member who scrutinised it (the owner until it is allocated). */
  owner: Pick<User, "name"> | null;
};

export type AllocationSourcer = Pick<User, "id" | "name"> & {
  /** Specialisation inside Team 2 (null = all categories). */
  category: MainCategory | null;
  isLeader: boolean;
  /** Allocated Qualified + Active leads they own. */
  load: number;
};

export interface AllocationView {
  /** Team 3 leader / admin; everyone else sees the pool read-only. */
  canAllocate: boolean;
  /** "NONE" = leads without a category. */
  category: MainCategory | "NONE" | null;
  page: number;
  pageSize: number;
  total: number;
  /** Pending leads per category, with the Team 2 member the assignment rules suggest. */
  categories: { category: MainCategory | null; pending: number; suggestedSourcerId: string | null }[];
  sourcers: AllocationSourcer[];
  pending: AllocationLead[];
  recent: (Pick<Candidate, "id" | "name" | "candidateCode" | "mainCategory" | "allocatedAt" | "stage"> & { owner: Pick<User, "name"> | null; allocatedBy: string | null })[];
}

// ───────────── Engagement (Team 2 / Team 3) ─────────────

export type EngagementRow = Pick<
  Candidate,
  "id" | "name" | "candidateCode" | "mainCategory" | "stage" | "lastPlatformVisitAt" | "jobIntentAt" | "lastEngagedAt" | "reengageSentAt"
> & {
  tier: EngagementTier;
  owner: Pick<User, "name"> | null;
  /** Latest inbound WhatsApp message. */
  lastReply: Pick<InboundMessage, "body" | "intent" | "receivedAt"> | null;
};

export interface EngagementView {
  /** Team 2 leader / Team 3 / admin see every lead; a sourcer sees their own. */
  scope: "mine" | "all";
  /** May mark job intent / send the WhatsApp (Team 2). */
  canAct: boolean;
  tier: EngagementTier | null;
  page: number;
  pageSize: number;
  total: number;
  days: EngagementTierDays;
  counts: Record<EngagementTier, number>;
  /** Cold leads messaged and still waiting for a reply. */
  awaitingReply: number;
  rows: EngagementRow[];
}

// ───────────── Cold-lead calls (Team 2) ─────────────

export type ColdCallOutcome = "UNANSWERED" | "NOT_INTERESTED" | "NEEDS_JOB";

export type ColdCallRow = Pick<Task, "id" | "dueAt" | "title"> & {
  /** The attempt this call will be (1 = first call on the allocation, 2+ = recalls). */
  attempt: number;
  assignee: Pick<User, "name"> | null;
  candidate: Pick<Candidate, "id" | "name" | "candidateCode" | "mainCategory" | "stage" | "lastEngagedAt" | "lastPlatformVisitAt" | "reengageSentAt"> & {
    tier: EngagementTier;
    owner: Pick<User, "name"> | null;
  };
  lastCall: Pick<ContactAttempt, "outcome" | "at"> | null;
};

export type ColdPoolLead = Pick<Candidate, "id" | "name" | "candidateCode" | "mainCategory" | "stage" | "lastEngagedAt" | "reengageSentAt"> & {
  owner: Pick<User, "name"> | null;
};

export interface ColdCallsView {
  /** Team 2 leader / admin: allocates, and may see the whole team's calls. */
  isLeader: boolean;
  scope: "mine" | "team";
  page: number;
  pageSize: number;
  total: number;
  maxAttempts: number;
  /** Today (IST), for the caller — or the whole team in team scope. */
  today: { allocated: number; calls: number; answered: number; superActive: number };
  rows: ColdCallRow[];
  /** Leader only: cold leads waiting to be allocated for a call. */
  pool: null | {
    category: MainCategory | "NONE" | null;
    total: number;
    categories: { category: MainCategory | null; waiting: number; suggestedCallerId: string | null }[];
    callers: { id: string; name: string; category: MainCategory | null; isLeader: boolean; openCalls: number }[];
    leads: ColdPoolLead[];
  };
}

export interface EngagementRoutes {
  "GET /v1/cold-calls": { query?: { scope?: "mine" | "team"; page?: number; category?: MainCategory | "NONE" }; response: ColdCallsView };
  "POST /v1/cold-calls/allocate": { body: { callerId: string; ids?: string[]; category?: MainCategory | "NONE"; count?: number }; response: MessageResult };
  "GET /v1/cold-calls/{id}/call": { params: { id: string }; response: LeadCallView };
  "POST /v1/cold-calls/{id}/log": { params: { id: string }; body: { outcome: ColdCallOutcome; notes?: string }; response: MessageResult };

  "GET /v1/allocation": { query?: { category?: MainCategory | "NONE"; page?: number }; response: AllocationView };
  "POST /v1/allocation": { body: { sourcerId: string; ids?: string[]; category?: MainCategory | "NONE" }; response: MessageResult };

  "GET /v1/engagement": { query?: { tier?: EngagementTier; page?: number }; response: EngagementView };
  "POST /v1/engagement/{id}/job-intent": { params: { id: string }; body: { notes?: string }; response: MessageResult };
  "POST /v1/engagement/{id}/reengage": { params: { id: string }; response: MessageResult };
}
