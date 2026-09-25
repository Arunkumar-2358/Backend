import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { resetDb, userId } from "../helpers";
import { call } from "./client";

beforeEach(resetDb);

async function raise(payload: Record<string, unknown> = { teamCode: "T1A", description: "Calls not logged" }, as = "sumitha") {
  return call({ method: "POST", url: "/v1/red-flags", payload, as });
}

describe("HTTP: red flags", () => {
  it("lets the coordinator raise a flag and refuses everyone else", async () => {
    const res = await raise({ teamCode: "T1A", description: "Calls not logged", kpiKey: "t1a.calls_attempted", dueDate: "2026-10-01" });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe("Red flag raised (T1A)");
    const f = await prisma.redFlag.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(f.kpiKey).toBe("t1a.calls_attempted");
    expect(f.kpiDeviated).toBeTruthy();
    expect(f.dueDate).not.toBeNull();
    expect((await raise(undefined, "sarala")).statusCode).toBe(403);
    expect((await raise(undefined, "jennifer")).statusCode).toBe(403);
  });

  it("validates the raise form", async () => {
    const noTeam = await raise({ description: "x" });
    expect(noTeam.statusCode).toBe(422);
    expect(noTeam.json().error.message).toBe("Choose a team");
    expect((await raise({ teamCode: "T9", description: "x" })).json().error.message).toBe("Choose a team");
    expect((await raise({ teamCode: "T2", description: "  " })).json().error.message).toBe("Describe the deviation");
    expect((await raise({ teamCode: "T2", description: "x", dueDate: "not-a-date" })).statusCode).toBe(422);
  });

  it("scopes the list: coordinator all (with raise options), leaders their teams, agents only owned actions", async () => {
    await raise({ teamCode: "T1A", description: "T1 issue" });
    await raise({ teamCode: "T2", description: "T2 issue" });
    const coord = (await call({ method: "GET", url: "/v1/red-flags", as: "sumitha" })).json();
    expect(coord.total).toBe(2);
    expect(coord.manage).toBe(true);
    expect(coord.raise.kpis.length).toBeGreaterThan(0);
    expect(coord.raise.members.length).toBeGreaterThan(0);

    const leader = (await call({ method: "GET", url: "/v1/red-flags", as: "sarala" })).json();
    expect(leader.flags.map((f: { description: string }) => f.description)).toEqual(["T1 issue"]);
    expect(leader.raise).toBeNull();

    expect((await call({ method: "GET", url: "/v1/red-flags", as: "jennifer" })).json().total).toBe(0);
    expect((await call({ method: "GET", url: "/v1/red-flags?team=T2&status=NOT_CLOSED&source=manual", as: "sumitha" })).json().total).toBe(1);
  });

  it("runs the CAPA workflow with per-step permissions", async () => {
    const id = (await raise()).json().id as string;
    const url = `/v1/red-flags/${id}`;

    expect((await call({ method: "GET", url, as: "dixha" })).statusCode).toBe(403);
    expect((await call({ method: "GET", url: "/v1/red-flags/nope", as: "sumitha" })).statusCode).toBe(404);
    const view = (await call({ method: "GET", url, as: "sarala" })).json();
    expect(view.manage).toBe(false);
    expect(view.users).toEqual([]);
    expect(view.sla).toBeGreaterThan(0);

    expect((await call({ method: "POST", url: `${url}/capa`, payload: { capaSuggested: "Retrain" }, as: "jennifer" })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: `${url}/capa`, payload: { capaSuggested: "" }, as: "sumitha" })).json().error.message).toBe("Enter the suggested CAPA");
    const capa = await call({ method: "POST", url: `${url}/capa`, payload: { capaSuggested: "Retrain", actionOwnerId: await userId("jennifer") }, as: "sumitha" });
    expect(capa.json().message).toBe("CAPA suggested");

    const owner = (await call({ method: "GET", url, as: "jennifer" })).json();
    expect(owner.isOwner).toBe(true);
    expect((await call({ method: "GET", url: "/v1/red-flags", as: "jennifer" })).json().total).toBe(1);

    expect((await call({ method: "POST", url: `${url}/implement`, payload: { correctiveActionImplemented: "Done" }, as: "bhavani" })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: `${url}/implement`, payload: {}, as: "jennifer" })).statusCode).toBe(422);
    expect((await call({ method: "POST", url: `${url}/close`, payload: {}, as: "sumitha" })).statusCode).toBe(422);
    expect((await call({ method: "POST", url: `${url}/implement`, payload: { correctiveActionImplemented: "Retrained" }, as: "jennifer" })).json().message).toBe("Corrective action recorded");

    expect((await call({ method: "POST", url: `${url}/close`, payload: {}, as: "jennifer" })).statusCode).toBe(403);
    const closed = await call({ method: "POST", url: `${url}/close`, payload: { achievedOutcome: "Better" }, as: "sumitha" });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().message).toMatch(/^Closed/);
    expect((await prisma.redFlag.findUniqueOrThrow({ where: { id } })).status).toBe("CLOSED");
  });
});
