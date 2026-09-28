/** Display labels and small lookup tables shared by the API and the web app. */
import type { ClientOrgType, ContactOutcome, TeamCode } from "../models";

export const OUTCOME_LABEL: Record<ContactOutcome, string> = {
  UNANSWERED: "Unanswered",
  NOT_INTERESTED: "Not interested",
  INTERESTED_LINK_SENT_NOT_REGISTERED: "Bb · Interested, link sent, not registered",
  BUSY_RECALL_REQUESTED: "Bc · Busy, recall requested",
  ANSWERED: "Answered",
  ENROLLED: "Enrolled",
  NEEDS_JOB: "Needs a job (super active)",
};

/** Which Team 3 pod a vacancy is routed to, by client type. */
export const ROUTING: Record<ClientOrgType, TeamCode> = { GENERAL: "T3A", EXISTING: "T3B", FREE_TRIAL: "T3C" };

export type CriterionInput = { name: string; weightPct?: number; children?: { name: string; weightPct: number }[] };

/** Default scorecard from the "Employee grading template" sheet. */
export const DEFAULT_CRITERIA: CriterionInput[] = [
  { name: "Domain knowledge", weightPct: 20 },
  { name: "Emotional intelligence", weightPct: 10 },
  { name: "Crisis management", weightPct: 10 },
  { name: "Strategy", weightPct: 10 },
  { name: "Communication & interpersonal skills", weightPct: 15 },
  { name: "Leadership qualities", children: [{ name: "Personality type", weightPct: 5 }, { name: "Delegation", weightPct: 5 }, { name: "Accountability & responsibility", weightPct: 10 }] },
  { name: "HRM", children: [{ name: "Employee engagement", weightPct: 10 }, { name: "Motivation", weightPct: 5 }] },
];
