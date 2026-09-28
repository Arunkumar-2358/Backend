import { Controller, Module } from "@nestjs/common";
import { z } from "zod";
import { MainCategory } from "@prisma/client";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { idParam, pageQuery } from "@/http/schemas";
import { getLeadForCall } from "@/modules/outreach/queries";
import { COLD_CALL_OUTCOMES, allocateColdCalls, logColdCall, openColdCallTask } from "./service";
import { getColdCalls } from "./queries";

const categoryParam = z.union([z.nativeEnum(MainCategory), z.literal("NONE")]);
const optText = (max = 2000) => z.string().trim().max(max).optional().transform((v) => v || undefined);

const OUTCOME_MESSAGE: Record<(typeof COLD_CALL_OUTCOMES)[number], string> = {
  UNANSWERED: "No answer logged",
  NOT_INTERESTED: "Logged — answered, not looking right now",
  NEEDS_JOB: "Needs a job — lead is Super active",
};

/** Team 2 cold-lead calls: the leader allocates cold leads, members call and log the outcome. */
@Controller()
export class ColdCallsController {
  @Endpoint("GET /v1/cold-calls", {
    summary: "Open cold-lead calls (own, or the team's for the Team 2 leader) and the leader's allocation pool",
    query: z.object({ scope: z.enum(["mine", "team"]).optional(), page: pageQuery.optional(), category: categoryParam.optional() }),
  })
  async list({ actor, query }: Ctx<"GET /v1/cold-calls">) {
    return getColdCalls(actor, query);
  }

  @Endpoint("POST /v1/cold-calls/allocate", {
    summary: "Team 2 leader allocates cold leads (ticked ones, or the next N of a category) to a Team 2 member to call",
    body: z
      .object({
        callerId: z.string().min(1).max(64),
        ids: z.array(z.string().min(1).max(64)).max(500).optional(),
        category: categoryParam.optional(),
        count: z.number().int().min(1).max(500).optional(),
      })
      .refine((b) => b.ids?.length || b.category, { message: "Pick the leads or a category to allocate" }),
  })
  async allocate({ actor, body }: Ctx<"POST /v1/cold-calls/allocate">) {
    const { count, caller } = await allocateColdCalls(actor, body);
    return { message: `${count} cold lead${count === 1 ? "" : "s"} allocated to ${caller.name} to call` };
  }

  @Endpoint("GET /v1/cold-calls/{id}/call", {
    summary: "Decrypted contact details for a cold-lead call (logged as a PII view)",
    params: idParam,
  })
  async callDetails({ actor, params }: Ctx<"GET /v1/cold-calls/{id}/call">) {
    await openColdCallTask(actor, params.id);
    return getLeadForCall(actor, params.id);
  }

  @Endpoint("POST /v1/cold-calls/{id}/log", {
    summary: "Log a cold-lead call: no answer (→ recall), answered not looking, or needs a job (→ super active)",
    params: idParam,
    body: z.object({ outcome: z.enum(COLD_CALL_OUTCOMES), notes: optText() }),
  })
  async log({ actor, params, body }: Ctx<"POST /v1/cold-calls/{id}/log">) {
    const r = await logColdCall(actor, params.id, body);
    const next = body.outcome === "UNANSWERED" ? (r.closed ? ` — closed after ${r.attempts} attempts` : " — it comes back as a recall") : "";
    return { message: `${OUTCOME_MESSAGE[body.outcome]}${next}` };
  }
}

@Module({ controllers: [ColdCallsController] })
export class ColdCallsModule {}
