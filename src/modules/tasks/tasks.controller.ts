import { Controller, Module } from "@nestjs/common";
import { z } from "zod";
import { TaskType } from "@prisma/client";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { idParam } from "@/http/schemas";
import { completeTask, listOpenTasks } from "./service";

@Controller()
export class TasksController {
  @Endpoint("GET /v1/tasks", {
    summary: "Open tasks (own, or the leader's teams with scope=team)",
    query: z.object({ scope: z.enum(["mine", "team"]).optional(), type: z.nativeEnum(TaskType).optional() }),
  })
  list({ actor, query }: Ctx<"GET /v1/tasks">) {
    return listOpenTasks(actor, query);
  }

  @Endpoint("POST /v1/tasks/{id}/complete", {
    summary: "Complete a task with an optional result note",
    params: idParam,
    body: z.object({ result: z.string().trim().max(2000).optional() }),
  })
  async complete({ actor, params, body }: Ctx<"POST /v1/tasks/{id}/complete">) {
    await completeTask(actor, params.id, body.result || "Done");
    return { message: "Task completed" };
  }
}

@Module({ controllers: [TasksController] })
export class TasksModule {}
