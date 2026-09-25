import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LeadSource, MainCategory, Stage } from "@prisma/client";
import type { Candidate, Channel, ContactDirection, ContactOutcome, DropReason } from "@prisma/client";
import type { LeadProfileForm } from "@contracts";
import { route } from "@/http/route";
import { idParam, pageQuery, queryBool } from "@/http/schemas";
import { prisma } from "@/lib/db";
import { GateError, ValidationError } from "@/lib/errors";
import { ForbiddenError, SYSTEM, STAGE_OWNER_TEAMS, isAdmin, isStageLeader } from "@/lib/rbac";
import { fromIstInputValue } from "@contracts/shared/dates";
import { normalizeMobile } from "@contracts/shared/phone";
import { CV_REGISTER_FIELDS, LEAD_SOURCES, MAIN_CATEGORIES, type CandidatePlain, type FieldDef } from "@contracts/shared/fields";
import { STAGE_LABEL, allowedTargets } from "@/modules/lifecycle/rules";
import { transitionLead } from "@/modules/lifecycle/transition";
import { verifyAndQualify } from "@/modules/scrutiny/service";
import { OUTCOME_LABEL, logContact, sendEnrolmentLink } from "@/modules/outreach/service";
import { teamMembers } from "@/modules/users/assignment";
import { searchPage } from "@/modules/search/queries";
import { createCandidate, decryptCandidate, reassignLead, requestDataDeletion, updateCandidate, type CandidateInput } from "./service";
import { isLeadVisible, leadDetail, leadsPage, visibleLead } from "./queries";

const DROP_REASONS: DropReason[] = ["INTERVIEW_NO_SHOW", "REJECTED", "OFFER_DECLINED", "LEFT_BEFORE_30_DAYS", "NOT_JOINED", "OTHER"];
const CHANNELS: Channel[] = ["CALL", "WHATSAPP", "SMS", "EMAIL"];
const DIRECTIONS: ContactDirection[] = ["OUTBOUND", "INBOUND_MISSED", "RECALL"];

const optStr = z.string().max(500).optional();
const optText = z.string().max(5000).optional();

/** Treat "" / whitespace like "not given", as the old FormData helpers did. */
const blank = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v.trim());

// ---- Profile form → CandidateInput -------------------------------------------

/** CV Register fields the profile editor saves (files and read-only fields are handled elsewhere). */
const EDITABLE_FIELDS: FieldDef[] = CV_REGISTER_FIELDS.filter((f) => f.type !== "readonly" && f.type !== "file");
/** Enum columns that are NOT NULL in the schema — an empty choice leaves them unchanged. */
const REQUIRED_ENUMS = new Set(["availabilityStatus", "source"]);

/** Convert the submitted profile form into typed CandidateInput (empty → null), relative to the current record. */
function profileInputFromForm(form: LeadProfileForm, current: Candidate & CandidatePlain): CandidateInput {
  const s = (k: string) => {
    const v = form[k];
    return typeof v === "string" ? blank(v) : undefined;
  };
  const n = (k: string) => {
    const v = s(k);
    if (v === undefined) return undefined;
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  };
  const input: Record<string, unknown> = {};
  for (const f of EDITABLE_FIELDS) {
    const k = f.key;
    switch (f.type) {
      case "text":
        if (k === "name") {
          const v = s(k);
          if (!v) throw new ValidationError("Name is required");
          input[k] = v;
        } else input[k] = s(k) ?? null;
        break;
      // Contact fields are only sent when changed (avoids needless re-encryption and clash checks).
      case "mobile": {
        const v = s(k);
        if (k === "mobile" && !v) throw new ValidationError("Mobile is required");
        const was = k === "mobile" ? current.mobile : current.altMobile;
        if (normalizeMobile(v ?? "") !== normalizeMobile(was ?? "")) input[k] = v ?? null;
        break;
      }
      case "email": {
        const v = s(k)?.toLowerCase() ?? null;
        if (v !== (current.email ?? null)) input[k] = v;
        break;
      }
      case "number": {
        const raw = s(k);
        const v = n(k);
        if (raw !== undefined && v === undefined) throw new ValidationError(`${f.label} must be a number`);
        input[k] = v ?? null;
        break;
      }
      case "int": {
        const raw = s(k);
        const v = n(k);
        if (raw !== undefined && (v === undefined || !Number.isInteger(v))) throw new ValidationError(`${f.label} must be a whole number`);
        input[k] = v ?? null;
        break;
      }
      case "date": {
        const raw = s(k);
        const d = raw ? fromIstInputValue(raw) : null;
        if (raw && !d) throw new ValidationError(`${f.label} is not a valid date`);
        input[k] = d;
        break;
      }
      case "enum": {
        const v = s(k);
        if (v && f.options && !f.options.includes(v)) throw new ValidationError(`Invalid value for ${f.label}`);
        if (!v && REQUIRED_ENUMS.has(k)) break;
        input[k] = v ?? null;
        break;
      }
      case "list": {
        const v = form[k];
        const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [];
        input[k] = items.map((x) => x.trim()).filter(Boolean);
        break;
      }
      case "bool": {
        const v = form[k] === true;
        // Only send consent when it changes, so the consent timestamp is not reset on every save.
        if (v !== Boolean(current[k])) input[k] = v;
        break;
      }
    }
  }
  return input as CandidateInput;
}

// ---- Routes -------------------------------------------------------------------

export async function leadRoutes(app: FastifyInstance) {
  route(app, "GET /v1/leads", {
    summary: "Leads & talent pool: filtered list (paged) or kanban board, within the caller's lead scope",
    query: z.object({
      view: z.enum(["list", "kanban"]).optional(),
      page: pageQuery.optional(),
      stage: z.nativeEnum(Stage).optional(),
      category: z.nativeEnum(MainCategory).optional(),
      owner: z.string().max(100).optional(),
      source: z.union([z.enum(["NT_ALL", "NON_NT"]), z.nativeEnum(LeadSource)]).optional(),
      cold: queryBool.optional(),
      q: z.string().max(1000).optional(),
    }),
    handler: async ({ actor, query }) => leadsPage(actor, query ?? {}),
  });

  route(app, "POST /v1/leads", {
    summary: "Create a lead by hand, then try to pass the Mapping gate",
    body: z.object({
      name: optStr,
      mobile: optStr,
      email: optStr,
      mainCategory: optStr,
      jobTitle: optStr,
      primarySpecialty: optStr,
      currentLocation: optStr,
      source: optStr,
      consent: z.boolean().optional(),
    }),
    handler: async ({ actor, body }) => {
      const name = blank(body.name);
      const mobile = blank(body.mobile);
      if (!name) throw new ValidationError("Name is required");
      if (!mobile) throw new ValidationError("Mobile is required");
      const category = blank(body.mainCategory);
      const source = blank(body.source) ?? "OTHER";
      if (category && !(MAIN_CATEGORIES as readonly string[]).includes(category)) throw new ValidationError("Unknown category");
      if (!(LEAD_SOURCES as readonly string[]).includes(source)) throw new ValidationError("Unknown source");

      const created = await createCandidate(
        actor,
        {
          name,
          mobile,
          email: blank(body.email) ?? null,
          mainCategory: (category as MainCategory | undefined) ?? null,
          jobTitle: blank(body.jobTitle) ?? null,
          primarySpecialty: blank(body.primarySpecialty) ?? null,
          currentLocation: blank(body.currentLocation) ?? null,
          source: source as LeadSource,
          consentRecordStoreShare: body.consent === true,
        },
        { ownerUserId: actor.id },
      );

      // Manual entry has already been de-duplicated by createCandidate; try to pass the Mapping gate.
      let gate: string | null = null;
      try {
        await transitionLead(isStageLeader(actor, "MAPPING") ? actor : SYSTEM("manual-entry"), created.id, "VALIDATED", { note: "Manual entry", source: "manual-entry" });
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
        gate = e.failures.join("; ");
      }
      // Routing may hand the lead to another team's agent; the creator may no longer see it.
      const visible = await isLeadVisible(actor, created.id);
      return { message: gate ? "Lead created and kept in Mapping" : "Lead created and moved to Validated", id: created.id, candidateCode: created.candidateCode, gate, visible };
    },
  });

  route(app, "GET /v1/leads/{id}", {
    summary: "Lead detail (decrypts contact details and records a PII view). 403 when the lead exists but is out of scope",
    params: idParam,
    handler: async ({ actor, params }) => leadDetail(actor, params.id),
  });

  route(app, "POST /v1/leads/{id}/transition", {
    summary: "Move a lead to an allowed stage (Enrolled → Qualified runs verify & qualify)",
    params: idParam,
    body: z.object({ to: optStr, note: optText, tlRemark: optText, dropReason: optStr }),
    handler: async ({ actor, params, body }) => {
      const id = params.id;
      const lead = await visibleLead(actor, id);
      const to = blank(body.to) as Stage | undefined;
      if (!to || !allowedTargets(lead.stage).includes(to)) throw new ValidationError("That stage change is not available from here");
      const note = blank(body.note);
      const tlRemark = blank(body.tlRemark);
      const dropReason = blank(body.dropReason) as DropReason | undefined;
      if (dropReason && !DROP_REASONS.includes(dropReason)) throw new ValidationError("Unknown drop reason");
      if (lead.stage === "ENROLLED" && to === "QUALIFIED") {
        await verifyAndQualify(actor, id, tlRemark ?? note);
      } else {
        await transitionLead(actor, id, to, { note, tlRemark, dropReason });
      }
      return { message: `Moved to ${STAGE_LABEL[to]}` };
    },
  });

  route(app, "PUT /v1/leads/{id}/profile", {
    summary: "Save the CV-register profile (owner, stage leader or admin)",
    params: idParam,
    body: z.record(z.union([z.string().max(5000), z.array(z.string().max(500)).max(100), z.boolean(), z.null()])),
    handler: async ({ actor, params, body }) => {
      const lead = await visibleLead(actor, params.id);
      const input = profileInputFromForm(body, decryptCandidate(lead));
      await updateCandidate(actor, params.id, input);
      return { message: "Profile saved" };
    },
  });

  route(app, "POST /v1/leads/{id}/contacts", {
    summary: "Log a contact attempt (may move the lead on)",
    params: idParam,
    body: z.object({ channel: optStr, direction: optStr, outcome: optStr, notes: optText, nextFollowupAt: optStr, firstTimeVerified: z.boolean().optional() }),
    handler: async ({ actor, params, body }) => {
      const id = params.id;
      await visibleLead(actor, id);
      const channel = blank(body.channel) as Channel | undefined;
      const outcome = blank(body.outcome) as ContactOutcome | undefined;
      const direction = (blank(body.direction) as ContactDirection | undefined) ?? "OUTBOUND";
      if (!channel || !CHANNELS.includes(channel)) throw new ValidationError("Pick a channel");
      if (!outcome || !(outcome in OUTCOME_LABEL)) throw new ValidationError("Pick an outcome");
      if (!DIRECTIONS.includes(direction)) throw new ValidationError("Unknown direction");
      const next = blank(body.nextFollowupAt);
      const nextFollowupAt = next ? fromIstInputValue(next) : null;
      if (next && !nextFollowupAt) throw new ValidationError("Invalid follow-up date");
      const { transitioned } = await logContact(actor, id, {
        channel,
        direction,
        outcome,
        notes: blank(body.notes),
        nextFollowupAt,
        isFirstTimeVerifiedCall: body.firstTimeVerified === true,
      });
      return { message: transitioned ? `Contact logged — lead moved to ${STAGE_LABEL[transitioned as Stage]}` : "Contact logged" };
    },
  });

  route(app, "POST /v1/leads/{id}/enrolment-link", {
    summary: "Send the enrolment link by WhatsApp, SMS or email",
    params: idParam,
    body: z.object({ channel: optStr }),
    handler: async ({ actor, params, body }) => {
      const id = params.id;
      await visibleLead(actor, id);
      const channel = blank(body.channel);
      if (channel !== "WHATSAPP" && channel !== "SMS" && channel !== "EMAIL") throw new ValidationError("Pick WhatsApp, SMS or Email");
      await sendEnrolmentLink(actor, id, channel);
      return { message: `Enrolment link sent by ${channel === "WHATSAPP" ? "WhatsApp" : channel === "SMS" ? "SMS" : "email"}` };
    },
  });

  route(app, "POST /v1/leads/{id}/reassign", {
    summary: "Reassign a lead within the team that owns its stage (stage leader only)",
    params: idParam,
    body: z.object({ toUserId: optStr }),
    handler: async ({ actor, params, body }) => {
      const id = params.id;
      const lead = await visibleLead(actor, id);
      if (!isStageLeader(actor, lead.stage)) throw new ForbiddenError("Only the team leader of this stage can reassign");
      const to = blank(body.toUserId);
      if (!to) throw new ValidationError("Pick a team member");
      const members = await teamMembers(STAGE_OWNER_TEAMS[lead.stage]);
      const member = members.find((m) => m.id === to);
      if (!member) throw new ValidationError("That person is not in the team that owns this stage");
      if (to === lead.ownerUserId) return { message: `${member.name} already owns this lead` };
      await reassignLead(actor, id, to);
      return { message: `Reassigned to ${member.name}` };
    },
  });

  route(app, "POST /v1/leads/{id}/deletion-requests", {
    summary: "Record a DPDP data-deletion request (admin only)",
    params: idParam,
    body: z.object({ requestedVia: optStr, reason: optText }),
    handler: async ({ actor, params, body }) => {
      if (!isAdmin(actor)) throw new ForbiddenError("Only an admin can record a data-deletion request");
      const id = params.id;
      await visibleLead(actor, id);
      const open = await prisma.dataDeletionRequest.count({ where: { candidateId: id, status: "REQUESTED" } });
      if (open) throw new ValidationError("A deletion request for this candidate is already pending");
      await requestDataDeletion(actor, id, { requestedVia: blank(body.requestedVia), reason: blank(body.reason) });
      return { message: "Deletion request recorded — process it from Administration" };
    },
  });

  route(app, "GET /v1/search", {
    summary: "Global search: leads (scoped), vacancies & clients, people — each group permission-filtered",
    query: z.object({ q: z.string().max(1000).optional() }),
    handler: async ({ actor, query }) => ({ result: await searchPage(actor, query?.q) }),
  });
}
