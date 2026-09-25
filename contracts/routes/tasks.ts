import type { Candidate, Notification, Task, TaskType, User } from "../models";
import type { MessageResult } from "../http";

export type TaskRow = Task & {
  candidate: Pick<Candidate, "id" | "name" | "candidateCode" | "stage"> | null;
  assignee: Pick<User, "name"> | null;
};

export interface TaskList {
  /** Effective scope; "team" is only granted to stage leaders. */
  scope: "mine" | "team";
  canViewTeam: boolean;
  tasks: TaskRow[];
}

export interface NotificationPage {
  rows: Notification[];
  total: number;
  unread: number;
  page: number;
  pageSize: number;
}

export interface TaskRoutes {
  "GET /v1/tasks": { query?: { scope?: "mine" | "team"; type?: TaskType }; response: TaskList };
  "POST /v1/tasks/{id}/complete": { params: { id: string }; body: { result?: string }; response: MessageResult };

  "GET /v1/notifications": { query?: { page?: number; unread?: boolean; kind?: string }; response: NotificationPage };
  "POST /v1/notifications/{id}/read": { params: { id: string }; response: MessageResult };
  "POST /v1/notifications/read-all": { response: MessageResult };
}
