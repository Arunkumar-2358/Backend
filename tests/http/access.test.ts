import { describe, it, expect, beforeAll } from "vitest";
import { resetDb } from "../helpers";
import { call } from "./client";

beforeAll(resetDb);

const status = async (url: string, as: string) => (await call({ method: "GET", url, as })).statusCode;

describe("HTTP: area access matches the app's role table", () => {
  it("keeps tele-callers out of vacancy, recruitment, scorecard, sourcing and admin data", async () => {
    for (const url of ["/v1/vacancies", "/v1/recruitment", "/v1/evaluations", "/v1/evaluation-templates", "/v1/scrutiny", "/v1/availability", "/v1/imports", "/v1/admin/users"]) {
      expect(await status(url, "bhavani"), url).toBe(403);
    }
    expect(await status("/v1/queue", "bhavani")).toBe(200);
    expect(await status("/v1/missed-calls", "bhavani")).toBe(200);
    // Red flags are scoped per caller instead: agents only ever see CAPA actions they own.
    expect((await call({ method: "GET", url: "/v1/red-flags", as: "bhavani" })).json().total).toBe(0);
  });

  it("lets each team into its own areas", async () => {
    expect(await status("/v1/vacancies", "harsha")).toBe(200);
    expect(await status("/v1/recruitment", "harsha")).toBe(200);
    expect(await status("/v1/queue", "harsha")).toBe(403);
    expect(await status("/v1/scrutiny", "srividya")).toBe(200);
    expect(await status("/v1/red-flags", "sumitha")).toBe(200);
    expect(await status("/v1/imports", "greeshma")).toBe(200);
  });

  it("lets admin into every area, and everyone into shared ones", async () => {
    for (const url of ["/v1/vacancies", "/v1/recruitment", "/v1/queue", "/v1/imports", "/v1/admin/users"]) expect(await status(url, "admin"), url).toBe(200);
    for (const url of ["/v1/kpi", "/v1/tasks", "/v1/leads", "/v1/dashboard"]) expect(await status(url, "bhavani"), url).toBe(200);
  });
});
