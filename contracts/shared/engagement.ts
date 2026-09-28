/**
 * Engagement tiers for enrolled + qualified leads (Qualified / Active stages).
 * A lead's tier comes from how many days have passed since it was last engaged:
 * the latest of enrolment (registering on the NT platform), a platform / app visit,
 * or the candidate confirming they need a job (e.g. a WhatsApp reply).
 */
import type { EngagementTier, Stage } from "../models";

/** Upper bounds (in days since last engaged) of each tier; anything older is Cold. */
export type EngagementTierDays = { superActive: number; active: number; warm: number };

export const DEFAULT_ENGAGEMENT_DAYS: EngagementTierDays = { superActive: 5, active: 14, warm: 60 };

/** Stages whose leads are tiered: enrolled and qualified, not yet sourced to a vacancy. */
export const ENGAGEMENT_STAGES: Stage[] = ["QUALIFIED", "ACTIVE"];

export const ENGAGEMENT_TIERS: EngagementTier[] = ["SUPER_ACTIVE", "ACTIVE", "WARM", "COLD"];

export const ENGAGEMENT_LABEL: Record<EngagementTier, string> = {
  SUPER_ACTIVE: "Super active",
  ACTIVE: "Active",
  WARM: "Warm",
  COLD: "Cold",
};

const DAY_MS = 86_400_000;

export function engagementTier(lastEngagedAt: Date | null | undefined, at: Date, days: EngagementTierDays = DEFAULT_ENGAGEMENT_DAYS): EngagementTier {
  if (!lastEngagedAt) return "COLD";
  const age = (at.getTime() - lastEngagedAt.getTime()) / DAY_MS;
  if (age <= days.superActive) return "SUPER_ACTIVE";
  if (age <= days.active) return "ACTIVE";
  if (age <= days.warm) return "WARM";
  return "COLD";
}

/**
 * The `lastEngagedAt` window of a tier, for database filters: engaged at or after
 * `from` and before `to` (either bound may be open). Cold also covers "never engaged".
 */
export function engagementWindow(tier: EngagementTier, at: Date, days: EngagementTierDays = DEFAULT_ENGAGEMENT_DAYS): { from?: Date; to?: Date; orNever?: true } {
  const ago = (d: number) => new Date(at.getTime() - d * DAY_MS);
  switch (tier) {
    case "SUPER_ACTIVE":
      return { from: ago(days.superActive) };
    case "ACTIVE":
      return { from: ago(days.active), to: ago(days.superActive) };
    case "WARM":
      return { from: ago(days.warm), to: ago(days.active) };
    case "COLD":
      return { to: ago(days.warm), orNever: true };
  }
}

/** Reads a reply to the re-engagement message: button ids first, then plain yes / no answers. */
export function readJobIntent(text: string): "LOOKING" | "NOT_LOOKING" | "UNCLEAR" {
  const t = text.trim().toLowerCase();
  if (t === "job_yes") return "LOOKING";
  if (t === "job_no") return "NOT_LOOKING";
  if (/^(no|nope|nah|not now|not interested|not looking|stop)\b/.test(t)) return "NOT_LOOKING";
  if (/^(yes|y|yeah|yep|haan|ha|han|interested|looking|i need a job|need a job|need job)\b/.test(t)) return "LOOKING";
  return "UNCLEAR";
}
