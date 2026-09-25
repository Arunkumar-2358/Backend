import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { SYSTEM } from "@/lib/rbac";
import { createTask } from "@/modules/tasks/service";
import { notify } from "@/modules/notifications/service";
import { resetDb, userId } from "../helpers";
import { call } from "./client";

beforeEach(resetDb);

async function taskFor(key: string, title = "Call back") {
  return createTask(SYSTEM("test"), { type: "FOLLOW_UP", title, assigneeId: await userId(key), dueAt: new Date(Date.now() - 60_000), notify: false });
}

describe("HTTP: tasks", () => {
  it("lists the caller's own open tasks, with dates revived as ISO strings", async () => {
    await taskFor("jennifer");
    await taskFor("bhavani");
    const res = await call({ method: "GET", url: "/v1/tasks", as: "jennifer" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe("mine");
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("only gives team scope to leaders", async () => {
    await taskFor("jennifer");
    const agent = await call({ method: "GET", url: "/v1/tasks?scope=team", as: "jennifer" });
    expect(agent.json().scope).toBe("mine");
    expect(agent.json().canViewTeam).toBe(false);
  });

  it("completes a task and refuses someone else's", async () => {
    const t = await taskFor("jennifer");
    expect((await call({ method: "POST", url: `/v1/tasks/${t.id}/complete`, payload: {}, as: "bhavani" })).statusCode).toBe(403);
    const ok = await call({ method: "POST", url: `/v1/tasks/${t.id}/complete`, payload: { result: "Spoke to them" }, as: "jennifer" });
    expect(ok.statusCode).toBe(200);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DONE");
  });

  it("rejects an unknown task type filter", async () => {
    expect((await call({ method: "GET", url: "/v1/tasks?type=BOGUS", as: "jennifer" })).statusCode).toBe(422);
  });
});

describe("HTTP: notifications", () => {
  it("pages, filters and marks notifications read for the caller only", async () => {
    const me = await userId("jennifer");
    await notify(me, { kind: "TASK", title: "One" });
    await notify(me, { kind: "SYSTEM", title: "Two" });
    await notify(await userId("bhavani"), { kind: "TASK", title: "Not mine" });

    const all = (await call({ method: "GET", url: "/v1/notifications", as: "jennifer" })).json();
    expect(all.total).toBe(2);
    expect(all.unread).toBe(2);
    expect((await call({ method: "GET", url: "/v1/notifications?kind=TASK", as: "jennifer" })).json().total).toBe(1);

    await call({ method: "POST", url: `/v1/notifications/${all.rows[0].id}/read`, as: "jennifer" });
    expect((await call({ method: "GET", url: "/v1/notifications?unread=true", as: "jennifer" })).json().total).toBe(1);
    await call({ method: "POST", url: "/v1/notifications/read-all", as: "jennifer" });
    expect((await call({ method: "GET", url: "/v1/notifications", as: "jennifer" })).json().unread).toBe(0);
    expect((await call({ method: "GET", url: "/v1/notifications", as: "bhavani" })).json().unread).toBe(1);
  });
});
