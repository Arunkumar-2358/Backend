/** Role and permission predicates shared by the API and the web app. */
import type { MainCategory, Role, Stage, TeamCode } from "../models";

export type RoleGrant = { role: Role; team: TeamCode; category: MainCategory | null };

export type Actor =
  | { kind: "user"; id: string; name: string; email: string; roles: RoleGrant[] }
  | { kind: "system"; label: string };

export const SYSTEM = (label: string): Actor => ({ kind: "system", label });

export const LEADER_ROLES: Role[] = ["team1_leader", "team2_leader", "team3_leader"];

export function roleSet(a: Actor): Set<Role> {
  return new Set(a.kind === "user" ? a.roles.map((r) => r.role) : []);
}

export function hasRole(a: Actor, ...roles: Role[]): boolean {
  if (a.kind === "system") return true;
  return a.roles.some((r) => roles.includes(r.role));
}

export function isAdmin(a: Actor) {
  return a.kind === "system" || a.roles.some((r) => r.role === "admin");
}

export function canReadAll(a: Actor) {
  return a.kind === "system" || a.roles.some((r) => r.role === "admin" || r.role === "ta_coordinator" || r.role === "data_analyst");
}

export function teamsOf(a: Actor): TeamCode[] {
  return a.kind === "user" ? [...new Set(a.roles.map((r) => r.team))] : [];
}

export function leaderTeams(a: Actor): TeamCode[] {
  if (a.kind !== "user") return [];
  const out = new Set<TeamCode>();
  for (const r of a.roles) {
    if (r.role === "team1_leader") ["T1A", "T1B"].forEach((t) => out.add(t as TeamCode));
    if (r.role === "team2_leader") out.add("T2");
    if (r.role === "team3_leader") ["T3A", "T3B", "T3C"].forEach((t) => out.add(t as TeamCode));
  }
  return [...out];
}

/** Which team owns each life-cycle stage (PLAN §3). */
export const STAGE_OWNER_TEAMS: Record<Stage, TeamCode[]> = {
  MAPPING: ["T4"],
  VALIDATED: ["T1A", "T1B"],
  ENROLLED: ["T2"],
  QUALIFIED: ["T2"],
  ACTIVE: ["T2"],
  SOURCED: ["T3A", "T3B", "T3C"],
  SELECTED: ["T3A", "T3B", "T3C"],
  JOINED: ["T3A", "T3B", "T3C"],
  SUCCESSFUL: [],
  NOT_INTERESTED: ["T1A", "T1B"],
  UNREACHABLE: ["T1A", "T1B"],
  DUPLICATE: ["T4"],
  INVALID: ["T4"],
  DROPPED: ["T3A", "T3B", "T3C"],
};

export function stagesOwnedBy(teams: TeamCode[]): Stage[] {
  return (Object.keys(STAGE_OWNER_TEAMS) as Stage[]).filter((s) => STAGE_OWNER_TEAMS[s].some((t) => teams.includes(t)));
}

export function isStageLeader(a: Actor, stage: Stage): boolean {
  if (isAdmin(a)) return true;
  // Team 4's data analyst is the sole owner (and sign-off) of the Mapping stage.
  if (STAGE_OWNER_TEAMS[stage].includes("T4") && a.kind === "user" && a.roles.some((r) => r.role === "data_analyst")) return true;
  const lt = leaderTeams(a);
  return STAGE_OWNER_TEAMS[stage].some((t) => lt.includes(t));
}

export function isStageTeamMember(a: Actor, stage: Stage): boolean {
  if (isAdmin(a)) return true;
  const teams = teamsOf(a);
  return STAGE_OWNER_TEAMS[stage].some((t) => teams.includes(t));
}

export function canEditLead(a: Actor, lead: { ownerUserId: string | null; stage: Stage }): boolean {
  if (isAdmin(a)) return true;
  if (a.kind !== "user") return false;
  if (lead.ownerUserId === a.id) return true;
  if (isStageLeader(a, lead.stage)) return true;
  if (lead.stage === "MAPPING" && hasRole(a, "data_analyst")) return true;
  return false;
}

export function canManageRedFlags(a: Actor): boolean {
  return a.kind === "system" || a.roles.some((r) => r.role === "admin" || r.role === "ta_coordinator");
}

export function actorId(a: Actor): string | null {
  return a.kind === "user" ? a.id : null;
}
export function actorLabel(a: Actor): string {
  return a.kind === "user" ? a.name : `system:${a.label}`;
}
