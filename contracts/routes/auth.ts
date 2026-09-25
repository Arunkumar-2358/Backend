import type { Notification, Role } from "../models";
import type { RoleGrant } from "../shared/rbac";

export interface LoginResult {
  token: string;
  /** Seconds until the token expires. */
  expiresIn: number;
  user: { id: string; name: string; email: string; roles: Role[]; theme: string };
}

export interface ShellData {
  user: { id: string; name: string; email: string; theme: string; roles: RoleGrant[] };
  overdueTasks: number;
  unread: number;
  notifications: Pick<Notification, "id" | "kind" | "title" | "body" | "link" | "readAt" | "createdAt">[];
}

export interface AuthRoutes {
  "POST /v1/auth/login": { body: { email: string; password: string }; response: LoginResult };
  "GET /v1/me/shell": { response: ShellData };
}
