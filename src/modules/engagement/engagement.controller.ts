import { Controller, Module } from "@nestjs/common";
import { z } from "zod";
import { EngagementTier, MainCategory } from "@prisma/client";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { idParam, pageQuery } from "@/http/schemas";
import { getAllocation } from "@/modules/allocation/queries";
import { allocateQualified } from "@/modules/allocation/service";
import { getEngagement } from "./queries";
import { markJobIntent, sendReengagement } from "./service";

const categoryParam = z.union([z.nativeEnum(MainCategory), z.literal("NONE")]);
const optText = (max = 2000) => z.string().trim().max(max).optional().transform((v) => v || undefined);

/** Team 3 → Team 2 allocation of qualified leads, and engagement tiers (super active → cold). */
@Controller()
export class EngagementController {
  // ───────────── Allocation (Team 3 leader) ─────────────

  @Endpoint("GET /v1/allocation", {
    summary: "Qualified leads waiting for the Team 3 leader to allocate them to Team 2, by category",
    query: z.object({ category: categoryParam.optional(), page: pageQuery.optional() }),
  })
  async allocation({ actor, query }: Ctx<"GET /v1/allocation">) {
    return getAllocation(actor, query);
  }

  @Endpoint("POST /v1/allocation", {
    summary: "Allocate qualified leads (chosen ones, or a whole category) to a Team 2 sourcer",
    body: z
      .object({ sourcerId: z.string().min(1).max(64), ids: z.array(z.string().min(1).max(64)).max(500).optional(), category: categoryParam.optional() })
      .refine((b) => b.ids?.length || b.category, { message: "Pick the leads or a category to allocate" }),
  })
  async allocate({ actor, body }: Ctx<"POST /v1/allocation">) {
    const { count, sourcer } = await allocateQualified(actor, body);
    return { message: `${count} lead${count === 1 ? "" : "s"} allocated to ${sourcer.name}` };
  }

  // ───────────── Engagement ─────────────

  @Endpoint("GET /v1/engagement", {
    summary: "Qualified / Active leads by engagement tier (super active, active, warm, cold)",
    query: z.object({ tier: z.nativeEnum(EngagementTier).optional(), page: pageQuery.optional() }),
  })
  async engagement({ actor, query }: Ctx<"GET /v1/engagement">) {
    return getEngagement(actor, query);
  }

  @Endpoint("POST /v1/engagement/{id}/job-intent", {
    summary: "The candidate confirmed they need a job → Super active now",
    params: idParam,
    body: z.object({ notes: optText() }),
  })
  async jobIntent({ actor, params, body }: Ctx<"POST /v1/engagement/{id}/job-intent">) {
    await markJobIntent(actor, params.id, body.notes);
    return { message: "Job need confirmed — lead is Super active" };
  }

  @Endpoint("POST /v1/engagement/{id}/reengage", {
    summary: "Send the cold-lead re-engagement WhatsApp now",
    params: idParam,
  })
  async reengage({ actor, params }: Ctx<"POST /v1/engagement/{id}/reengage">) {
    await sendReengagement(actor, params.id);
    return { message: "Re-engagement WhatsApp sent — a reply saying they need a job makes the lead Super active" };
  }
}

@Module({ controllers: [EngagementController] })
export class EngagementModule {}
