/**
 * Life-cycle stage rules (PLAN §3). This is the single module to change when
 * the business changes a gate. transitionLead() is the only code that applies them.
 */
import type { Candidate, DropReason, Stage } from "@prisma/client";
import type { Tx } from "@/lib/db";
import type { Settings } from "@/lib/settings";
import { validateMobile } from "@contracts/shared/phone";
import { decrypt } from "@/lib/crypto";
import { EXITS, NEXT_STAGE } from "@contracts/shared/lifecycle";

export { PIPELINE, EXIT_STAGES, TERMINAL_STAGES, NEXT_STAGE, EXITS, STAGE_LABEL, allowedTargets } from "@contracts/shared/lifecycle";

export type TransitionPayload = {
  note?: string;
  dropReason?: DropReason;
  tlRemark?: string;
  /** set by system flows (import, webhook) that already verified their own preconditions */
  source?: string;
};

/** Who may perform a transition: any member of the stage's owning team, or only its leader. */
export type Performer = "stage_team" | "stage_leader";

export type GateCtx = {
  db: Tx;
  lead: Candidate;
  payload: TransitionPayload;
  settings: Settings;
};

type Rule = { performer: Performer; gate: (ctx: GateCtx) => Promise<string[]>; description: string };

const pass = async () => [] as string[];

/** Gate rules keyed "FROM->TO". */
export const RULES: Record<string, Rule> = {
  "MAPPING->VALIDATED": {
    performer: "stage_team",
    description: "Duplicates removed; mobile is exactly 10 digits; category and geography assigned",
    gate: async ({ lead }) => {
      const f: string[] = [];
      if (lead.duplicateCheckStatus !== "UNIQUE") f.push("Duplicate check has not passed");
      const m = validateMobile(decrypt(lead.mobileEnc));
      if (!m.ok) f.push(m.reason);
      if (!lead.mainCategory) f.push("Job category not assigned");
      if (!lead.jobTitle && !lead.professionFunctionalHead && !lead.primarySpecialty) f.push("Job title / profession not assigned");
      if (!lead.currentLocation && lead.preferredLocations.length === 0) f.push("Geography (current or preferred location) not assigned");
      return f;
    },
  },
  "VALIDATED->ENROLLED": {
    performer: "stage_team",
    description: "A contact attempt with outcome ENROLLED is logged (or the NT platform confirmed registration)",
    gate: async ({ db, lead }) => {
      const n = await db.contactAttempt.count({ where: { candidateId: lead.id, outcome: "ENROLLED" } });
      return n > 0 ? [] : ["No contact attempt with outcome ENROLLED has been logged"];
    },
  },
  "ENROLLED->QUALIFIED": {
    performer: "stage_leader",
    description: "All mandatory SOP fields complete (100%), verified by the Team 2 leader",
    gate: async ({ lead }) => {
      const f: string[] = [];
      if (lead.profileCompletenessPct < 100) f.push(`Profile is ${lead.profileCompletenessPct}% complete — all mandatory SOP fields are required`);
      if (!lead.consentRecordStoreShare) f.push("Consent to store & share CV not recorded");
      return f;
    },
  },
  "QUALIFIED->ACTIVE": {
    performer: "stage_team",
    description: "Allocated to a Team 2 sourcer by the Team 3 leader; latest availability check-in confirmed the candidate is available",
    gate: async ({ db, lead }) => {
      const f: string[] = [];
      if (!lead.allocatedAt) f.push("Not yet allocated to a Team 2 sourcer by the Team 3 leader");
      const last = await db.availabilityCheck.findFirst({ where: { candidateId: lead.id }, orderBy: { checkedAt: "desc" } });
      if (!last?.available) f.push("Latest availability check-in has not confirmed availability");
      return f;
    },
  },
  "ACTIVE->SOURCED": {
    performer: "stage_team",
    description: "CV forwarded to a recruiter against a vacancy (consent on file)",
    gate: async ({ db, lead }) => {
      const f: string[] = [];
      if (!lead.consentRecordStoreShare) f.push("Consent to share CV is required before it leaves the system (DPDP)");
      const n = await db.submission.count({ where: { candidateId: lead.id } });
      if (!n) f.push("No submission to a vacancy exists");
      return f;
    },
  },
  "SOURCED->SELECTED": {
    performer: "stage_team",
    description: "Interview fixed and communicated, attended, and candidate selected",
    gate: async ({ db, lead }) => {
      const iv = await db.interview.findFirst({
        where: { submission: { candidateId: lead.id }, status: "ATTENDED", result: "SELECTED", communicatedAt: { not: null } },
      });
      return iv ? [] : ["No attended interview with result SELECTED (interview must have been communicated)"];
    },
  },
  "SELECTED->JOINED": {
    performer: "stage_team",
    description: "Offer letter sent, joining date confirmed, candidate joined",
    gate: async ({ db, lead }) => {
      const offer = await db.offer.findFirst({ where: { submission: { candidateId: lead.id } }, include: { joining: true }, orderBy: { sentAt: "desc" } });
      const f: string[] = [];
      if (!offer) f.push("No offer letter sent");
      else {
        if (!offer.joiningDate) f.push("Joining date not confirmed");
        if (!offer.joining) f.push("Joining not recorded");
      }
      return f;
    },
  },
  "JOINED->SUCCESSFUL": {
    performer: "stage_team",
    description: "Joining formalities complete; retained at day 7 and day 30",
    gate: async ({ db, lead }) => {
      const j = await db.joining.findFirst({ where: { offer: { submission: { candidateId: lead.id } } }, orderBy: { joinedAt: "desc" } });
      const f: string[] = [];
      if (!j) return ["No joining recorded"];
      if (!j.formalitiesCompletedAt) f.push("Joining formalities not complete");
      if (!j.retained7dAt) f.push("Day-7 retention check not passed");
      if (!j.retained30dAt) f.push("Day-30 retention check not passed");
      if (j.leftAt) f.push("Candidate has left");
      return f;
    },
  },
};

/** Exit gates. */
const EXIT_RULES: Partial<Record<Stage, Rule>> = {
  NOT_INTERESTED: { performer: "stage_team", description: "Candidate said not interested", gate: async ({ payload, db, lead }) => {
    if (payload.note) return [];
    const n = await db.contactAttempt.count({ where: { candidateId: lead.id, outcome: "NOT_INTERESTED" } });
    return n ? [] : ["Log a NOT_INTERESTED contact outcome or give a note"];
  } },
  UNREACHABLE: { performer: "stage_team", description: "Contact attempts reached the configured cap", gate: async ({ lead, settings }) =>
    lead.contactAttemptCount >= settings.maxContactAttempts ? [] : [`Only ${lead.contactAttemptCount} of ${settings.maxContactAttempts} contact attempts made`] },
  DUPLICATE: { performer: "stage_team", description: "Marked as a duplicate of another record", gate: async ({ payload }) => (payload.note ? [] : ["Give a note identifying the original record"]) },
  INVALID: { performer: "stage_team", description: "Data is invalid", gate: async ({ payload }) => (payload.note ? [] : ["Give a reason"]) },
  DROPPED: { performer: "stage_team", description: "Dropped with a reason code", gate: async ({ payload }) => (payload.dropReason ? [] : ["A drop reason code is required"]) },
};

export function ruleFor(from: Stage, to: Stage): Rule | null {
  if (NEXT_STAGE[from] === to) return RULES[`${from}->${to}`] ?? { performer: "stage_team", description: "", gate: pass };
  if ((EXITS[from] ?? []).includes(to)) return EXIT_RULES[to] ?? null;
  return null;
}
