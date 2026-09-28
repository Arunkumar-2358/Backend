/**
 * Who may open each area of the app. The web uses it for the menu and route gating;
 * the API enforces the same table on every endpoint in an area (see src/http/route.ts).
 */
import type { Role } from "../models";

export type NavItem = { href: string; label: string; roles: Role[] | "all"; group: string };

const T1: Role[] = ["ta_lead", "team1_leader", "telecaller"];
const T2: Role[] = ["sourcer", "team2_leader"];
const T3: Role[] = ["recruiter", "team3_leader"];
const LEADERS: Role[] = ["team1_leader", "team2_leader", "team3_leader"];

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", roles: "all", group: "Home" },
  { href: "/tasks", label: "My tasks", roles: "all", group: "Home" },
  { href: "/notifications", label: "Notifications", roles: "all", group: "Home" },
  { href: "/leads", label: "Leads & talent pool", roles: "all", group: "Pipeline" },
  { href: "/import", label: "Data import", roles: ["data_analyst", "admin"], group: "Team 4 · Mapping" },
  { href: "/queue", label: "Outreach queue", roles: [...T1, "admin"], group: "Team 1 · Outreach" },
  { href: "/missed-calls", label: "Missed calls", roles: ["telecaller", "team1_leader", "admin"], group: "Team 1 · Outreach" },
  { href: "/scrutiny", label: "Enrolment scrutiny", roles: [...T2, "admin"], group: "Team 2 · Sourcing" },
  { href: "/availability", label: "Availability check-ins", roles: [...T2, "admin"], group: "Team 2 · Sourcing" },
  { href: "/engagement", label: "Engagement (active → cold)", roles: [...T2, ...T3, "admin"], group: "Team 2 · Sourcing" },
  { href: "/cold-calls", label: "Cold-lead calls", roles: [...T2, "admin"], group: "Team 2 · Sourcing" },
  { href: "/vacancies", label: "Vacancies & matching", roles: ["ta_lead", "team1_leader", ...T2, ...T3, "admin", "ta_coordinator"], group: "Vacancies" },
  { href: "/allocation", label: "Qualified → Team 2 allocation", roles: [...T3, "team2_leader", "admin"], group: "Team 3 · Recruitment" },
  { href: "/recruitment", label: "Interviews → joining", roles: [...T3, "admin"], group: "Team 3 · Recruitment" },
  { href: "/evaluations", label: "Scorecards", roles: [...T3, "admin"], group: "Team 3 · Recruitment" },
  { href: "/red-flags", label: "Red flags & CAPA", roles: ["ta_coordinator", "admin", ...LEADERS], group: "Quality" },
  { href: "/kpi", label: "KPI analysis", roles: "all", group: "Quality" },
  { href: "/profile", label: "My profile", roles: "all", group: "Account" },
  { href: "/admin", label: "Administration", roles: ["admin"], group: "Account" },
];

export function navFor(roles: Role[]): NavItem[] {
  return NAV.filter((n) => n.roles === "all" || n.roles.some((r) => roles.includes(r)));
}

export function canAccessPath(path: string, roles: Role[]): boolean {
  const item = [...NAV].sort((a, b) => b.href.length - a.href.length).find((n) => path === n.href || path.startsWith(n.href + "/"));
  if (!item) return true;
  if (roles.includes("admin")) return true;
  return item.roles === "all" || item.roles.some((r) => roles.includes(r));
}
