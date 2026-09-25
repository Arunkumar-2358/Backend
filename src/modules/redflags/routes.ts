import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TeamCode } from "@prisma/client";
import { route } from "@/http/route";
import { idParam, pageQuery } from "@/http/schemas";
import { ValidationError } from "@/lib/errors";
import { fromIstInputValue } from "@contracts/shared/dates";
import { KPI_BY_KEY } from "@/kpi/definitions";
import { implementCapa, raiseRedFlag, suggestCapa, verifyAndClose } from "./service";
import { TEAM_CODES, listRedFlags, redFlagDetail } from "./queries";

/** Optional trimmed text; blank means "not given" (like the web's str()). */
const text = z
  .string()
  .max(5000)
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

/** A due date picked as a calendar day means "by the end of that IST day". */
function dueDateOf(v: string | undefined): Date | null {
  if (!v) return null;
  const d = fromIstInputValue(v);
  if (!d) throw new ValidationError(`Invalid date "${v}"`);
  return new Date(d.getTime() + 86_400_000 - 60_000);
}

export async function redFlagRoutes(app: FastifyInstance) {
  route(app, "GET /v1/red-flags", {
    summary: "Red flags visible to the caller (all for coordinator/admin, own teams for leaders, own actions otherwise)",
    query: z.object({ team: z.string().optional(), status: z.string().optional(), source: z.string().optional(), period: z.string().optional(), page: pageQuery.optional() }),
    handler: async ({ actor, query }) => listRedFlags(actor, query),
  });

  route(app, "GET /v1/red-flags/{id}", {
    summary: "One red flag with its CAPA trail and SLA deadline",
    params: idParam,
    handler: async ({ actor, params }) => redFlagDetail(actor, params.id),
  });

  route(app, "POST /v1/red-flags", {
    summary: "Raise a red flag (TA coordinator / admin)",
    body: z.object({ teamCode: text, description: text, agentId: text, kpiKey: text, kpiOther: text, targetStandard: text, actual: text, dueDate: text }),
    handler: async ({ actor, body }) => {
      const teamCode = body.teamCode as TeamCode | undefined;
      if (!teamCode || !TEAM_CODES.includes(teamCode)) throw new ValidationError("Choose a team");
      if (!body.description) throw new ValidationError("Describe the deviation");
      const def = body.kpiKey && body.kpiKey !== "__other" ? KPI_BY_KEY[body.kpiKey] : undefined;
      const f = await raiseRedFlag(actor, {
        teamCode,
        description: body.description,
        agentId: body.agentId ?? null,
        kpiKey: def?.key ?? null,
        kpiDeviated: def?.label ?? body.kpiOther ?? null,
        targetStandard: body.targetStandard ?? null,
        actual: body.actual ?? null,
        dueDate: dueDateOf(body.dueDate),
      });
      return { message: `Red flag raised (${f.teamCode})`, id: f.id };
    },
  });

  route(app, "POST /v1/red-flags/{id}/capa", {
    summary: "Suggest (or update) the CAPA for a red flag (TA coordinator / admin)",
    params: idParam,
    body: z.object({ capaSuggested: text, expectedOutcome: text, dueDate: text, actionOwnerId: text }),
    handler: async ({ actor, params, body }) => {
      if (!body.capaSuggested) throw new ValidationError("Enter the suggested CAPA");
      await suggestCapa(actor, params.id, {
        capaSuggested: body.capaSuggested,
        expectedOutcome: body.expectedOutcome,
        dueDate: dueDateOf(body.dueDate),
        actionOwnerId: body.actionOwnerId ?? null,
      });
      return { message: "CAPA suggested" };
    },
  });

  route(app, "POST /v1/red-flags/{id}/implement", {
    summary: "Record the corrective action (action owner, TA coordinator or admin)",
    params: idParam,
    body: z.object({ correctiveActionImplemented: text, achievedOutcome: text }),
    handler: async ({ actor, params, body }) => {
      if (!body.correctiveActionImplemented) throw new ValidationError("Describe the corrective action implemented");
      await implementCapa(actor, params.id, { correctiveActionImplemented: body.correctiveActionImplemented, achievedOutcome: body.achievedOutcome });
      return { message: "Corrective action recorded" };
    },
  });

  route(app, "POST /v1/red-flags/{id}/close", {
    summary: "Verify the corrective action and close the red flag (TA coordinator / admin)",
    params: idParam,
    body: z.object({ achievedOutcome: text }),
    handler: async ({ actor, params, body }) => {
      const f = await verifyAndClose(actor, params.id, body.achievedOutcome);
      return { message: f.closedWithin1WorkingDay ? "Closed within the SLA" : "Closed (beyond the SLA)" };
    },
  });
}
