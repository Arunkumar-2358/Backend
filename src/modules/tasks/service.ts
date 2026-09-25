import type { Prisma, TaskType } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { now } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { type Actor, ForbiddenError, isAdmin, leaderTeams } from "@/lib/rbac";
import { formatDateTime } from "@contracts/shared/dates";
import { notify, isBulkActor } from "@/modules/notifications/service";

export type NewTask = {
  type: TaskType;
  title: string;
  candidateId?: string | null;
  assigneeId?: string | null;
  dueAt: Date;
  refType?: string;
  refId?: string;
  /** default true: notify the assignee (unless they created it, or it comes from a bulk import) */
  notify?: boolean;
};

export async function createTask(actor: Actor, input: NewTask, db: Tx = prisma) {
  const { notify: shouldNotify = true, ...t } = input;
  const task = await db.task.create({
    data: {
      ...t,
      createdAt: now(),
      createdBy: actor.kind === "user" ? actor.id : `system:${actor.label}`,
    },
  });
  await audit(actor, "TASK_CREATED", "task", task.id, { type: t.type, candidateId: t.candidateId, dueAt: t.dueAt, assigneeId: t.assigneeId }, db);
  if (shouldNotify && t.assigneeId && !isBulkActor(actor)) {
    const lead = t.candidateId ? await db.candidate.findUnique({ where: { id: t.candidateId }, select: { name: true, candidateCode: true } }) : null;
    await notify(t.assigneeId, {
      kind: "TASK",
      title: t.title,
      body: lead ? `${lead.name} · ${lead.candidateCode} · due ${formatDateTime(t.dueAt)}` : `Due ${formatDateTime(t.dueAt)}`,
      link: t.candidateId ? `/leads/${t.candidateId}` : t.refType === "red_flag" && t.refId ? `/red-flags/${t.refId}` : "/tasks",
    }, db, actor);
  }
  return task;
}

/** Create a task only if no open task of the same type/ref exists for the lead. */
export async function ensureOpenTask(actor: Actor, t: NewTask, db: Tx = prisma) {
  const existing = await db.task.findFirst({
    where: { type: t.type, candidateId: t.candidateId ?? undefined, refId: t.refId ?? undefined, status: "OPEN" },
  });
  if (existing) return existing;
  return createTask(actor, t, db);
}

export async function closeTasks(where: Prisma.TaskWhereInput, result: string, db: Tx = prisma, status: "DONE" | "CANCELLED" = "DONE") {
  return db.task.updateMany({ where: { status: "OPEN", ...where }, data: { status, result, completedAt: now() } });
}

export async function cancelOpenTasksForLead(candidateId: string, reason: string, db: Tx = prisma, types?: TaskType[]) {
  return closeTasks({ candidateId, ...(types ? { type: { in: types } } : {}) }, reason, db, "CANCELLED");
}

export async function completeTask(actor: Actor, taskId: string, result: string | null, db: Tx = prisma) {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  if (actor.kind === "user" && task.assigneeId !== actor.id && !isAdmin(actor) && leaderTeams(actor).length === 0)
    throw new ForbiddenError("Only the assignee or a team leader can complete this task");
  const updated = await db.task.update({ where: { id: taskId }, data: { status: "DONE", result, completedAt: now() } });
  await audit(actor, "TASK_COMPLETED", "task", taskId, { result }, db);
  return updated;
}

/** Open tasks for the task list: the actor's own, or (leaders only) their teams'. */
export async function listOpenTasks(actor: Extract<Actor, { kind: "user" }>, opts: { scope?: "mine" | "team"; type?: TaskType }) {
  const teams = leaderTeams(actor);
  const scope = opts.scope === "team" && teams.length > 0 ? "team" : "mine";
  const tasks = await prisma.task.findMany({
    where: {
      status: "OPEN",
      ...(opts.type ? { type: opts.type } : {}),
      ...(scope === "mine" ? { assigneeId: actor.id } : { assignee: { roles: { some: { team: { code: { in: teams } } } } } }),
    },
    include: { candidate: { select: { id: true, name: true, candidateCode: true, stage: true } }, assignee: { select: { name: true } } },
    orderBy: { dueAt: "asc" },
    take: 300,
  });
  return { scope, canViewTeam: teams.length > 0, tasks } as const;
}
