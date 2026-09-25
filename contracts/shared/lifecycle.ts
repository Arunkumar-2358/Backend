/** Life-cycle stage graph and labels (PLAN §3). Gate rules live in the API. */
import type { Stage } from "../models";

export const STAGE_LABEL: Record<Stage, string> = {
  MAPPING: "Mapping",
  VALIDATED: "Validated",
  ENROLLED: "Enrolled",
  QUALIFIED: "Qualified",
  ACTIVE: "Active",
  SOURCED: "Sourced",
  SELECTED: "Selected",
  JOINED: "Joined",
  SUCCESSFUL: "Successful",
  NOT_INTERESTED: "Not interested",
  UNREACHABLE: "Unreachable",
  DUPLICATE: "Duplicate",
  INVALID: "Invalid",
  DROPPED: "Dropped",
};

export const PIPELINE: Stage[] = ["MAPPING", "VALIDATED", "ENROLLED", "QUALIFIED", "ACTIVE", "SOURCED", "SELECTED", "JOINED", "SUCCESSFUL"];
export const EXIT_STAGES: Stage[] = ["NOT_INTERESTED", "UNREACHABLE", "DUPLICATE", "INVALID", "DROPPED"];
export const TERMINAL_STAGES: Stage[] = ["SUCCESSFUL", ...EXIT_STAGES];

export const NEXT_STAGE: Partial<Record<Stage, Stage>> = {
  MAPPING: "VALIDATED",
  VALIDATED: "ENROLLED",
  ENROLLED: "QUALIFIED",
  QUALIFIED: "ACTIVE",
  ACTIVE: "SOURCED",
  SOURCED: "SELECTED",
  SELECTED: "JOINED",
  JOINED: "SUCCESSFUL",
};

export const EXITS: Partial<Record<Stage, Stage[]>> = {
  MAPPING: ["DUPLICATE", "INVALID"],
  VALIDATED: ["NOT_INTERESTED", "UNREACHABLE", "DUPLICATE", "INVALID"],
  ENROLLED: ["NOT_INTERESTED"],
  QUALIFIED: ["NOT_INTERESTED"],
  ACTIVE: ["NOT_INTERESTED"],
  SOURCED: ["DROPPED"],
  SELECTED: ["DROPPED"],
  JOINED: ["DROPPED"],
};

export function allowedTargets(from: Stage): Stage[] {
  const next = NEXT_STAGE[from];
  return [...(next ? [next] : []), ...(EXITS[from] ?? [])];
}
