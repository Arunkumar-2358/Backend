// Endpoints for the signed-in user's own profile. See contracts/README.md.
// (GET /v1/me/shell lives in routes/auth.ts.)
import type { AuditLog, Stage, Team, User, UserTeamRole } from "../models";
import type { MessageResult } from "../http";

export interface ProfileView {
  user: Pick<User, "id" | "name" | "email" | "phone" | "theme" | "createdAt" | "lastLoginAt"> & {
    roles: (Pick<UserTeamRole, "id" | "role" | "category"> & { team: Pick<Team, "name"> })[];
  };
  openTasks: number;
  overdue: number;
  owned: number;
  /** Owned leads per stage, largest first. */
  byStage: { stage: Stage; count: number }[];
  contactsThisWeek: number;
  doneThisWeek: number;
  /** Days marked present this IST week. */
  attendance: number;
  /** Latest 12 audit rows by the user, excluding PII views. */
  activity: Pick<AuditLog, "id" | "at" | "action" | "entityType" | "entityId">[];
}

export interface ProfileRoutes {
  "GET /v1/me/profile": { response: ProfileView };
  "PUT /v1/me/profile": { body: { name: string; phone?: string }; response: MessageResult };
  "PUT /v1/me/password": { body: { current: string; next: string; confirm: string }; response: MessageResult };
  "PUT /v1/me/theme": { body: { theme: string }; response: MessageResult & { theme: "light" | "dark" | "system" } };
}
