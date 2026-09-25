/** Vacancy display labels shared by the API (command messages) and the web app. */
import type { ClientOrgType, TeamCode } from "../models";

export const TEAM_LABEL: Partial<Record<TeamCode, string>> = { T3A: "3a · General", T3B: "3b · Existing clients", T3C: "3c · Free trial" };
export const ORG_TYPE_LABEL: Record<ClientOrgType, string> = { GENERAL: "General", EXISTING: "Existing client", FREE_TRIAL: "Free trial" };
