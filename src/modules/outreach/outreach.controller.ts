import { Controller, Module } from "@nestjs/common";
import { z } from "zod";
import { MainCategory } from "@prisma/client";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { idParam, pageQuery, queryBool } from "@/http/schemas";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { GateError, ValidationError } from "@/lib/errors";
import { SYSTEM, assert, hasRole } from "@/lib/rbac";
import { STAGE_LABEL } from "@contracts/shared/lifecycle";
import { NON_NT_SOURCES, fieldLabel } from "@contracts/shared/fields";
import { transitionLead } from "@/modules/lifecycle/transition";
import { createCandidate } from "@/modules/candidates/service";
import { recordAvailabilityCheck, scrutinize, setCold, verifyAndQualify } from "@/modules/scrutiny/service";
import { getAvailability, getScrutiny } from "@/modules/scrutiny/queries";
import { OUTCOME_LABEL, allocateToTelecaller, logContact, logMissedCall, recordRecall, sendEnrolmentLink } from "./service";
import { MISSED_CALL_ROLES, getLeadForCall, getMissedCallForRecall, getMissedCallInbox, getQueue } from "./queries";

/** Optional free text: trimmed, and blank becomes undefined (like the web's str()). */
const optText = (max = 2000) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const stageLabel = (s: string) => STAGE_LABEL[s as keyof typeof STAGE_LABEL] ?? s;

@Controller()
export class OutreachController {
  // ───────────── Outreach queue (Team 1) ─────────────

  @Endpoint("GET /v1/queue", {
    summary: "Outreach queue of Validated leads (own, or the whole team for the Team 1 leader)",
    query: z.object({ scope: z.enum(["mine", "team"]).optional(), overdue: queryBool.optional(), page: pageQuery.optional() }),
  })
  async queue({ actor, query }: Ctx<"GET /v1/queue">) {
    return getQueue(actor, query);
  }

  @Endpoint("GET /v1/queue/{id}/call", {
    summary: "Decrypted contact details for dialling a lead (logged as a PII view)",
    params: idParam,
  })
  async callDetails({ actor, params }: Ctx<"GET /v1/queue/{id}/call">) {
    return getLeadForCall(actor, params.id);
  }

  @Endpoint("POST /v1/queue/{id}/contact", {
    summary: "Log a contact attempt; the outcome drives follow-ups and stage moves",
    params: idParam,
    body: z.object({
      channel: z.enum(["CALL", "WHATSAPP", "SMS", "EMAIL"]),
      outcome: z.enum(["UNANSWERED", "INTERESTED_LINK_SENT_NOT_REGISTERED", "BUSY_RECALL_REQUESTED", "NOT_INTERESTED", "ENROLLED"]),
      notes: optText(),
      firstCall: z.boolean().optional(),
    }),
  })
  async contact({ actor, params, body }: Ctx<"POST /v1/queue/{id}/contact">) {
    const { transitioned } = await logContact(actor, params.id, {
      channel: body.channel,
      outcome: body.outcome,
      notes: body.notes,
      isFirstTimeVerifiedCall: body.channel === "CALL" && !!body.firstCall,
    });
    const label = OUTCOME_LABEL[body.outcome];
    if (transitioned) return { message: `${label} logged — lead moved to ${stageLabel(transitioned)}` };
    return { message: `${label} logged — next follow-up scheduled` };
  }

  @Endpoint("POST /v1/queue/{id}/enrolment-link", {
    summary: "Send the enrolment link from a template (logged as a Bb attempt)",
    params: idParam,
    body: z.object({ channel: z.enum(["WHATSAPP", "SMS", "EMAIL"]) }),
  })
  async enrolmentLink({ actor, params, body }: Ctx<"POST /v1/queue/{id}/enrolment-link">) {
    const { transitioned } = await sendEnrolmentLink(actor, params.id, body.channel);
    const via = body.channel === "WHATSAPP" ? "WhatsApp" : body.channel === "SMS" ? "SMS" : "email";
    return {
      message: transitioned ? `Link sent by ${via} — lead moved to ${stageLabel(transitioned)} (attempt cap reached)` : `Enrolment link sent by ${via} (logged as Bb)`,
    };
  }

  @Endpoint("POST /v1/queue/allocate", {
    summary: "Team 1 leader allocates Validated leads to a tele-caller for first-time verified calls",
    body: z.object({ ids: z.array(z.string().min(1)).max(500), telecallerId: z.string().trim() }),
  })
  async allocate({ actor, body }: Ctx<"POST /v1/queue/allocate">) {
    assert(hasRole(actor, "team1_leader", "admin"), "Only the Team 1 leader can allocate calls");
    if (!body.ids.length) throw new ValidationError("Tick at least one lead to allocate");
    if (!body.telecallerId) throw new ValidationError("Choose a tele-caller");
    const n = await allocateToTelecaller(actor, body.ids, body.telecallerId);
    return { message: `${n} lead${n === 1 ? "" : "s"} allocated for first-time verified calls${n < body.ids.length ? ` (${body.ids.length - n} skipped — no longer Validated)` : ""}` };
  }

  @Endpoint("POST /v1/queue/portal-leads", {
    summary: "TA lead adds a proactive lead from a non-NT portal (counts toward non-NT KPIs)",
    body: z.object({
      name: z.string().trim().max(200),
      mobile: z.string().trim().max(20),
      source: z.enum(NON_NT_SOURCES, { errorMap: () => ({ message: "Choose the portal (Naukri, LinkedIn, Indeed or other portal)" }) }),
      mainCategory: z.nativeEnum(MainCategory).optional(),
      currentLocation: optText(200),
      jobTitle: optText(200),
    }),
  })
  async addPortalLead({ actor, body }: Ctx<"POST /v1/queue/portal-leads">) {
    assert(hasRole(actor, "ta_lead", "team1_leader", "admin"), "Only TA leads can add portal leads");
    if (!body.name) throw new ValidationError("Name is required");
    if (!body.mobile) throw new ValidationError("Mobile is required");
    const c = await createCandidate(
      actor,
      { name: body.name, mobile: body.mobile, source: body.source, mainCategory: body.mainCategory, currentLocation: body.currentLocation, jobTitle: body.jobTitle },
      { ownerUserId: actor.id },
    );
    try {
      // The Mapping gate is still enforced. A system actor performs the move because the
      // Mapping stage belongs to Team 4 and a TA lead is not a member of it.
      await transitionLead(SYSTEM("portal-lead"), c.id, "VALIDATED", { note: `Proactive non-NT portal lead added by ${actor.name}`, source: "portal-lead" });
    } catch (e) {
      if (e instanceof GateError) return { message: `Lead ${c.candidateCode} saved, but it went to Mapping for the data analyst — ${e.failures.join("; ")}` };
      throw e;
    }
    return { message: `Lead ${c.candidateCode} added to your queue (Validated)` };
  }

  // ───────────── Missed-call inbox (Team 1b) ─────────────

  @Endpoint("GET /v1/missed-calls", {
    summary: "Missed-call inbox (own, or the whole team for leaders) with this week's recall funnel",
    query: z.object({ tab: z.enum(["open", "closed"]).optional(), page: pageQuery.optional() }),
  })
  async missedCalls({ actor, query }: Ctx<"GET /v1/missed-calls">) {
    return getMissedCallInbox(actor, query);
  }

  @Endpoint("POST /v1/missed-calls", {
    summary: "Log a missed incoming call (creates a recall task)",
    body: z.object({ mobile: z.string().trim().max(20), receivedAt: z.coerce.date().optional(), notes: optText() }),
  })
  async addMissedCall({ actor, body }: Ctx<"POST /v1/missed-calls">) {
    assert(hasRole(actor, ...MISSED_CALL_ROLES), "Only Team 1b can log missed calls");
    if (!body.mobile) throw new ValidationError("Enter the caller's number");
    if (body.receivedAt && body.receivedAt.getTime() > now().getTime() + 5 * 60_000) throw new ValidationError("Received time is in the future");
    await logMissedCall(actor, { mobile: body.mobile, receivedAt: body.receivedAt, notes: body.notes });
    return { message: "Missed call logged — recall task created" };
  }

  @Endpoint("GET /v1/missed-calls/{id}/call", {
    summary: "Decrypted caller number for a recall (logged as a PII view)",
    params: idParam,
  })
  async missedCallDetails({ actor, params }: Ctx<"GET /v1/missed-calls/{id}/call">) {
    return getMissedCallForRecall(actor, params.id);
  }

  @Endpoint("POST /v1/missed-calls/{id}/recall", {
    summary: "Record a recall: answered / link sent / enrolled, optionally creating a lead for an unknown caller",
    params: idParam,
    body: z.object({
      answered: z.boolean().optional(),
      linkSent: z.boolean().optional(),
      enrolled: z.boolean().optional(),
      notes: optText(),
      name: optText(200),
      mainCategory: z.nativeEnum(MainCategory).optional(),
      currentLocation: optText(200),
      jobTitle: optText(200),
    }),
  })
  async recall({ actor, params, body }: Ctx<"POST /v1/missed-calls/{id}/recall">) {
    assert(hasRole(actor, ...MISSED_CALL_ROLES), "Only Team 1b can record recalls");
    const mc = await prisma.missedCall.findUnique({ where: { id: params.id } });
    if (!mc) throw new ValidationError("Missed call not found");
    assert(mc.assignedToId === actor.id || mc.assignedToId === null || hasRole(actor, "team1_leader", "admin"), "This missed call is assigned to another tele-caller");
    if (mc.closedAt) throw new ValidationError("This missed call is already closed");

    const answered = !!body.answered;
    const linkSent = !!body.linkSent;
    const enrolled = !!body.enrolled;
    if (enrolled && !answered && !linkSent) throw new ValidationError("Tick 'Answered' or 'Link sent' before marking the caller enrolled");

    const newLead = !mc.candidateId && body.name ? { name: body.name, mainCategory: body.mainCategory, currentLocation: body.currentLocation, jobTitle: body.jobTitle } : undefined;
    if (newLead && !answered) throw new ValidationError("A new lead can only be created when the caller answered");
    if (!mc.candidateId && enrolled && !newLead) throw new ValidationError("Unknown caller — add their name and category to create a lead before marking enrolled");

    const res = await recordRecall(actor, mc.id, { answered, linkSent, enrolled, notes: body.notes, newLead });
    const parts = [answered ? "answered" : "not answered — another recall is scheduled in 2 hours"];
    if (linkSent) parts.push("link sent");
    if (enrolled) parts.push("enrolled");
    if (newLead && res.candidateId) {
      const lead = await prisma.candidate.findUnique({ where: { id: res.candidateId }, select: { candidateCode: true, stage: true } });
      if (lead) parts.push(lead.stage === "MAPPING" ? `lead ${lead.candidateCode} created (in Mapping — needs category / job title / location)` : `lead ${lead.candidateCode} created`);
    }
    return { message: `Recall saved: ${parts.join(", ")}${res.closedAt ? " · closed" : ""}` };
  }

  // ───────────── Availability check-ins (Team 2) ─────────────

  @Endpoint("GET /v1/availability", {
    summary: "Qualified leads, due availability check-ins and cold → warm conversions",
    query: z.object({ page: pageQuery.optional(), cold: queryBool.optional() }),
  })
  async availability({ actor, query }: Ctx<"GET /v1/availability">) {
    return getAvailability(actor, query);
  }

  @Endpoint("POST /v1/availability/{id}/check", {
    summary: "Record an availability check-in (available → Active; not available → cold)",
    params: idParam,
    body: z.object({ available: z.boolean(), notes: optText() }),
  })
  async checkAvailability({ actor, params, body }: Ctx<"POST /v1/availability/{id}/check">) {
    assert(hasRole(actor, "sourcer", "team2_leader", "admin"), "Only Team 2 records availability check-ins");
    await recordAvailabilityCheck(actor, params.id, body.available, body.notes);
    return { message: body.available ? "Availability confirmed — lead moved to Active" : "Recorded as not available — lead flagged cold; next check-in scheduled" };
  }

  @Endpoint("POST /v1/availability/{id}/cold", {
    summary: "Flag a lead cold or warm",
    params: idParam,
    body: z.object({ cold: z.boolean() }),
  })
  async cold({ actor, params, body }: Ctx<"POST /v1/availability/{id}/cold">) {
    await setCold(actor, params.id, body.cold);
    return { message: body.cold ? "Flagged cold" : "Flagged warm" };
  }

  // ───────────── Enrolment scrutiny (Team 2) ─────────────

  @Endpoint("GET /v1/scrutiny", {
    summary: "Enrolled leads awaiting scrutiny, with SOP completeness",
    query: z.object({ tab: z.enum(["incomplete", "complete", "all"]).optional(), page: pageQuery.optional() }),
  })
  async scrutiny({ actor, query }: Ctx<"GET /v1/scrutiny">) {
    return getScrutiny(actor, query);
  }

  @Endpoint("POST /v1/scrutiny/{id}/scrutinize", {
    summary: "Scrutinise an enrolled lead (opens a collect-details task if fields are missing)",
    params: idParam,
    body: z.object({ remark: optText() }),
  })
  async scrutinize({ actor, params, body }: Ctx<"POST /v1/scrutiny/{id}/scrutinize">) {
    const check = await scrutinize(actor, params.id, body.remark);
    return {
      message: check.missing.length
        ? `Scrutinised — ${check.missing.length} field(s) missing (${check.missing.map(fieldLabel).join(", ")}). A "collect details" call task is open.`
        : "Scrutinised — profile complete, awaiting team leader verification",
    };
  }

  @Endpoint("POST /v1/scrutiny/{id}/verify", {
    summary: "Team 2 leader verifies an enrolled lead and moves it to Qualified",
    params: idParam,
    body: z.object({ tlRemark: optText() }),
  })
  async verify({ actor, params, body }: Ctx<"POST /v1/scrutiny/{id}/verify">) {
    await verifyAndQualify(actor, params.id, body.tlRemark);
    return { message: "Verified — lead moved to Qualified" };
  }
}

@Module({ controllers: [OutreachController] })
export class OutreachModule {}
