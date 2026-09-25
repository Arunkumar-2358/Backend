/** Read model for the global search page. */
import type { Role } from "@prisma/client";
import type { SearchResults } from "@contracts";
import { decrypt } from "@/lib/crypto";
import { hasRole, type Actor } from "@/lib/rbac";
import { maskMobile } from "@contracts/shared/phone";
import { globalSearch } from "./service";

/** Roles that may open /vacancies (mirrors the web nav gate); admin always may. */
const VACANCY_ROLES: Role[] = ["sourcer", "team2_leader", "recruiter", "team3_leader", "admin", "ta_coordinator"];

/**
 * Grouped search results. Vacancies/clients are only searched for roles that can open
 * Vacancies; people only for admins, team leaders and TA coordinators. Mobiles are masked.
 */
export async function searchPage(actor: Actor, raw: string | undefined): Promise<SearchResults | null> {
  const q = raw?.trim() ?? "";
  if (!q) return null;
  const vacancies = hasRole(actor, ...VACANCY_ROLES);
  const people = hasRole(actor, "admin", "team1_leader", "team2_leader", "team3_leader", "ta_coordinator");
  const r = await globalSearch(actor, q, { vacancies, people });
  if (!r) return null;
  return {
    leadCount: r.leadCount,
    vacancyCount: r.vacancyCount,
    leads: r.leads.map((c) => ({
      id: c.id,
      name: c.name,
      candidateCode: c.candidateCode,
      mainCategory: c.mainCategory,
      primarySpecialty: c.primarySpecialty,
      currentLocation: c.currentLocation,
      stage: c.stage,
      isCold: c.isCold,
      owner: c.owner,
      mobileMasked: maskMobile(decrypt(c.mobileEnc)),
    })),
    vacancies: r.vacancies.map((v) => ({
      id: v.id,
      title: v.title,
      code: v.code,
      category: v.category,
      location: v.location,
      postedAt: v.postedAt,
      status: v.status,
      clientOrg: { name: v.clientOrg.name },
      _count: { submissions: v._count.submissions },
    })),
    clients: r.clients.map((o) => ({ id: o.id, name: o.name, type: o.type, city: o.city, _count: { vacancies: o._count.vacancies } })),
    people: r.people.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      active: u.active,
      roles: u.roles.map((g) => ({ role: g.role, team: { name: g.team.name } })),
    })),
  };
}
