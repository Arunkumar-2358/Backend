import type { Notification, Role } from "../models";
import type { MessageResult } from "../http";
import type { RoleGrant } from "../shared/rbac";

export interface LoginResult {
  /** Short-lived access token (JWT). Send as `Authorization: Bearer` or the `nt_session` cookie. */
  token: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Opaque refresh token; single use — every refresh returns a new one. Keep it httpOnly. */
  refreshToken: string;
  /** ISO time after which the refresh token is no longer accepted (idle or absolute limit). */
  refreshExpiresAt: string;
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
  /** 401 when the refresh token is unknown, expired, revoked or reused — the client must sign in again. */
  "POST /v1/auth/refresh": { body: { refreshToken: string }; response: LoginResult };
  /** Ends this device's session. Accepts the refresh token and/or the access token; always succeeds. */
  "POST /v1/auth/logout": { body: { refreshToken?: string }; response: MessageResult };
  /** Ends every session of the signed-in user except (optionally) this one. */
  "POST /v1/auth/logout-all": { body: { keepCurrent?: boolean }; response: { revoked: number } };
  "GET /v1/me/shell": { response: ShellData };
}
