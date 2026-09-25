import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route } from "@/http/route";
import { TaskType } from "@prisma/client";
import { idParam } from "@/http/schemas";
import { completeTask, listOpenTasks } from "./service";

export async function taskRoutes(app: FastifyInstance) {
  route(app, "GET /v1/tasks", {
    summary: "Open tasks (own, or the leader's teams with scope=team)",
    query: z.object({ scope: z.enum(["mine", "team"]).optional(), type: z.nativeEnum(TaskType).optional() }),
    handler: async ({ actor, query }) => listOpenTasks(actor, query),
  });

  route(app, "POST /v1/tasks/{id}/complete", {
    summary: "Complete a task with an optional result note",
    params: idParam,
    body: z.object({ result: z.string().trim().max(2000).optional() }),
    handler: async ({ actor, params, body }) => {
      await completeTask(actor, params.id, body.result || "Done");
      return { message: "Task completed" };
    },
  });
}
