// Endpoints for the redflags domain. See contracts/README.md.
import type { RedFlag, Team, User } from "../models";
import type { MessageResult } from "../http";

export type RedFlagRow = RedFlag & { agent: Pick<User, "name"> | null; actionOwner: Pick<User, "name"> | null };

/** Options for the "Raise red flag" form (coordinator / admin only). */
export interface RaiseRedFlagOptions {
  teams: { code: string; name: string }[];
  members: { id: string; name: string; teams: string[] }[];
  kpis: { key: string; label: string; team: string; sheetTitle: string; target?: string }[];
}

export interface RedFlagList {
  manage: boolean;
  page: number;
  pageSize: number;
  total: number;
  flags: RedFlagRow[];
  teams: Pick<Team, "code" | "name">[];
  raise: RaiseRedFlagOptions | null;
}

export interface RedFlagDetail {
  flag: RedFlag & {
    agent: Pick<User, "name"> | null;
    actionOwner: Pick<User, "id" | "name"> | null;
    raisedBy: Pick<User, "name"> | null;
  };
  manage: boolean;
  isOwner: boolean;
  /** Closure SLA in working days. */
  sla: number;
  slaDeadline: Date;
  todayIsHoliday: boolean;
  /** Action-owner choices (coordinator / admin only). */
  users: Pick<User, "id" | "name">[];
}

/** Dates are IST calendar days ("YYYY-MM-DD"), meaning "by the end of that day". */
export interface RaiseRedFlagBody {
  teamCode?: string;
  description?: string;
  agentId?: string;
  kpiKey?: string;
  kpiOther?: string;
  targetStandard?: string;
  actual?: string;
  dueDate?: string;
}

export interface RedFlagRoutes {
  "GET /v1/red-flags": {
    query?: { team?: string; status?: string; source?: string; period?: string; page?: number };
    response: RedFlagList;
  };
  "GET /v1/red-flags/{id}": { params: { id: string }; response: RedFlagDetail };
  "POST /v1/red-flags": { body: RaiseRedFlagBody; response: MessageResult & { id: string } };
  "POST /v1/red-flags/{id}/capa": {
    params: { id: string };
    body: { capaSuggested?: string; expectedOutcome?: string; dueDate?: string; actionOwnerId?: string };
    response: MessageResult;
  };
  "POST /v1/red-flags/{id}/implement": {
    params: { id: string };
    body: { correctiveActionImplemented?: string; achievedOutcome?: string };
    response: MessageResult;
  };
  "POST /v1/red-flags/{id}/close": {
    params: { id: string };
    body: { achievedOutcome?: string };
    response: MessageResult;
  };
}
