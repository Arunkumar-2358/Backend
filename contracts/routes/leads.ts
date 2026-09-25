// Endpoints for the leads domain (list, board, detail, commands) and the global search page. See contracts/README.md.
import type {
  AuditLog,
  Candidate,
  ClientOrg,
  ContactAttempt,
  DataDeletionRequest,
  Interview,
  Joining,
  LeadSource,
  LeadStageHistory,
  MainCategory,
  Message,
  Offer,
  Role,
  Stage,
  Submission,
  Task,
  TeamCode,
  User,
  Vacancy,
} from "../models";
import type { MessageResult } from "../http";

type Named = Pick<User, "name">;

// ---- List & board -----------------------------------------------------------

export type LeadSourceFilter = LeadSource | "NT_ALL" | "NON_NT";

export interface LeadListQuery {
  view?: "list" | "kanban";
  page?: number;
  /** List only: the board ignores it (stages are its columns). */
  stage?: Stage;
  category?: MainCategory;
  /** "me", "none" (unassigned) or a user id. */
  owner?: string;
  source?: LeadSourceFilter;
  cold?: boolean;
  q?: string;
}

export type LeadListRow = Pick<
  Candidate,
  | "id"
  | "candidateCode"
  | "name"
  | "source"
  | "mainCategory"
  | "primarySpecialty"
  | "jobTitle"
  | "currentLocation"
  | "preferredLocations"
  | "stage"
  | "isCold"
  | "profileCompletenessPct"
  | "nextFollowupAt"
> & {
  owner: Named | null;
  /** Masked mobile (last 4 digits only); the full number is never listed. */
  mobileMasked: string;
};

export type LeadCard = Pick<Candidate, "id" | "name" | "candidateCode" | "mainCategory" | "primarySpecialty" | "isCold"> & { owner: Named | null };

export interface LeadListPage {
  rows: LeadListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LeadBoard {
  /** Leads per stage (pipeline and exits) matching the filters. */
  counts: Partial<Record<Stage, number>>;
  /** The most recently moved cards per pipeline stage. */
  columns: Partial<Record<Stage, LeadCard[]>>;
  cardsPerColumn: number;
}

/** view=list fills `list`; view=kanban fills `board`. */
export interface LeadsPage {
  owners: Pick<User, "id" | "name">[];
  list: LeadListPage | null;
  board: LeadBoard | null;
}

// ---- Detail -----------------------------------------------------------------

/** The lead with contact details decrypted (encrypted columns and blind indexes are not sent). */
export type LeadProfile = Omit<Candidate, "mobileEnc" | "mobileHash" | "mobileLast4" | "altMobileEnc" | "emailEnc" | "emailHash"> & {
  mobile: string | null;
  altMobile: string | null;
  email: string | null;
  owner: Pick<User, "id" | "name"> | null;
  verifiedBy: Named | null;
  importBatch: { id: string; fileName: string } | null;
};

export interface LeadTransitionOption {
  to: Stage;
  /** "stage_leader" = needs the stage team leader's sign-off. null when no rule applies. */
  performer: "stage_team" | "stage_leader" | null;
  description: string | null;
}

export type LeadSubmission = Submission & {
  vacancy: Pick<Vacancy, "id" | "code" | "title"> & { clientOrg: Pick<ClientOrg, "name"> };
  interviews: Interview[];
  offers: (Offer & { joining: Joining | null })[];
};

export interface LeadDetail {
  lead: LeadProfile;
  checklist: { mandatory: string[]; missing: string[]; pct: number };
  can: {
    edit: boolean;
    stageLeader: boolean;
    /** Admin or TA coordinator. */
    viewAudit: boolean;
    admin: boolean;
    stagePanel: boolean;
    logContact: boolean;
  };
  /** Allowed stage changes from the current stage, in allowedTargets order. */
  transitions: LeadTransitionOption[];
  tasks: (Pick<Task, "id" | "title" | "type" | "dueAt"> & { assignee: Named | null })[];
  attempts: (ContactAttempt & { byUser: Named | null })[];
  history: (LeadStageHistory & { byUser: Named | null })[];
  submissions: LeadSubmission[];
  messages: Message[];
  /** Admins only (empty otherwise). */
  deletionRequests: DataDeletionRequest[];
  /** Admins and TA coordinators only (empty otherwise). */
  audits: AuditLog[];
  /** Stage leaders only: active members of the teams that own the current stage. */
  members: { id: string; name: string; teams: TeamCode[] }[];
  fileLimits: { resumeBytes: number; videoBytes: number };
}

// ---- Commands ---------------------------------------------------------------

export interface CreateLeadBody {
  name?: string;
  mobile?: string;
  email?: string;
  mainCategory?: string;
  jobTitle?: string;
  primarySpecialty?: string;
  currentLocation?: string;
  source?: string;
  consent?: boolean;
}

export interface CreateLeadResult extends MessageResult {
  id: string;
  candidateCode: string;
  /** Unmet Mapping-gate failures ("; "-joined), or null when the lead moved to Validated. */
  gate: string | null;
  /** False when routing handed the lead to someone the creator cannot see. */
  visible: boolean;
}

/**
 * The profile editor's fields as submitted: text-like fields as trimmed strings (null = empty),
 * list fields as string arrays, checkboxes as booleans. The API converts and validates them.
 */
export type LeadProfileForm = Record<string, string | string[] | boolean | null>;

// ---- Search -----------------------------------------------------------------

export type SearchLead = Pick<Candidate, "id" | "name" | "candidateCode" | "mainCategory" | "primarySpecialty" | "currentLocation" | "stage" | "isCold"> & {
  owner: Named | null;
  mobileMasked: string;
};
export type SearchVacancy = Pick<Vacancy, "id" | "title" | "code" | "category" | "location" | "postedAt" | "status"> & {
  clientOrg: Pick<ClientOrg, "name">;
  _count: { submissions: number };
};
export type SearchClient = Pick<ClientOrg, "id" | "name" | "type" | "city"> & { _count: { vacancies: number } };
export type SearchPerson = Pick<User, "id" | "name" | "email" | "active"> & { roles: { role: Role; team: { name: string } }[] };

export interface SearchResults {
  leads: SearchLead[];
  leadCount: number;
  vacancies: SearchVacancy[];
  vacancyCount: number;
  clients: SearchClient[];
  people: SearchPerson[];
}

export interface LeadRoutes {
  "GET /v1/leads": { query?: LeadListQuery; response: LeadsPage };
  "POST /v1/leads": { body: CreateLeadBody; response: CreateLeadResult };
  "GET /v1/leads/{id}": { params: { id: string }; response: LeadDetail };
  "POST /v1/leads/{id}/transition": {
    params: { id: string };
    body: { to?: string; note?: string; tlRemark?: string; dropReason?: string };
    response: MessageResult;
  };
  "PUT /v1/leads/{id}/profile": { params: { id: string }; body: LeadProfileForm; response: MessageResult };
  "POST /v1/leads/{id}/contacts": {
    params: { id: string };
    /** nextFollowupAt is a datetime-local value in IST ("YYYY-MM-DDTHH:mm"). */
    body: { channel?: string; direction?: string; outcome?: string; notes?: string; nextFollowupAt?: string; firstTimeVerified?: boolean };
    response: MessageResult;
  };
  "POST /v1/leads/{id}/enrolment-link": { params: { id: string }; body: { channel?: string }; response: MessageResult };
  "POST /v1/leads/{id}/reassign": { params: { id: string }; body: { toUserId?: string }; response: MessageResult };
  "POST /v1/leads/{id}/deletion-requests": { params: { id: string }; body: { requestedVia?: string; reason?: string }; response: MessageResult };

  /** Global search (leads, vacancies, clients, people — each group permission-filtered). `result` is null for an empty query. */
  "GET /v1/search": { query?: { q?: string }; response: { result: SearchResults | null } };
}
