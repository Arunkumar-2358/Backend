/**
 * Search used by the header (global results page) and the list pages.
 *
 * Contact details are encrypted, so they can't be searched with LIKE. A full
 * mobile or email matches exactly via its blind index; 4 digits match the last
 * 4 of the mobile. Everything else is tokenised: every word must match at least
 * one text field ("nurse hyderabad" = nurses in Hyderabad).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeMobile } from "@contracts/shared/phone";
import { blindIndex } from "@/lib/crypto";
import { type Actor, leadScope } from "@/lib/rbac";

const MAX_TOKENS = 6;

export function tokens(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
}

const ci = (t: string) => ({ contains: t, mode: "insensitive" as const });

const LEAD_TEXT_FIELDS = [
  "name", "candidateCode", "jobTitle", "primarySpecialty", "professionFunctionalHead", "currentLocation",
  "currentOrg", "currentDesignation", "basicQualification", "registrationNumber",
] as const;

/** Prisma filter for a lead search query (combine with leadScope). null = empty query. */
export function leadSearchWhere(raw: string | undefined | null): Prisma.CandidateWhereInput | null {
  const q = raw?.trim();
  if (!q) return null;

  // Whole query is an email → exact match on the blind index.
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)) return { emailHash: blindIndex(q.toLowerCase()) };

  // Whole query is a phone number (spaces, +91, dashes allowed).
  const digits = normalizeMobile(q);
  if (/^[\d\s+\-()]+$/.test(q)) {
    if (/^\d{10}$/.test(digits)) return { mobileHash: blindIndex(digits) };
    const d = q.replace(/\D/g, "");
    if (/^\d{4}$/.test(d)) return { OR: [{ mobileLast4: d }, { candidateCode: { endsWith: d } }] };
    return { candidateCode: { endsWith: d } };
  }

  // Words: each must match some field.
  return {
    AND: tokens(q).map((t) => {
      const cap = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
      const or: Prisma.CandidateWhereInput[] = LEAD_TEXT_FIELDS.map((f) => ({ [f]: ci(t) }) as Prisma.CandidateWhereInput);
      // arrays are matched on the element as usually written ("Hyderabad", "ICU")
      or.push({ preferredLocations: { has: cap } }, { preferredLocations: { has: t.toUpperCase() } }, { secondarySkills: { has: cap } }, { secondarySkills: { has: t.toUpperCase() } });
      const cat = t.toUpperCase().replace(/S$/, "");
      if (["DOCTOR", "NURSE", "PHARMACY", "ALLIED", "ADMIN"].includes(cat)) or.push({ mainCategory: cat as never });
      if (/^PHARMAC/i.test(t)) or.push({ mainCategory: "PHARMACY" });
      return { OR: or };
    }),
  };
}

export function vacancySearchWhere(raw: string | undefined | null): Prisma.VacancyWhereInput | null {
  const q = raw?.trim();
  if (!q) return null;
  return {
    AND: tokens(q).map((t) => {
      const or: Prisma.VacancyWhereInput[] = [
        { code: ci(t) }, { title: ci(t) }, { specialty: ci(t) }, { location: ci(t) }, { clientOrg: { name: ci(t) } },
      ];
      const cat = t.toUpperCase().replace(/S$/, "");
      if (["DOCTOR", "NURSE", "PHARMACY", "ALLIED", "ADMIN"].includes(cat)) or.push({ category: cat as never });
      return { OR: or };
    }),
  };
}

export function clientSearchWhere(raw: string | undefined | null): Prisma.ClientOrgWhereInput | null {
  const q = raw?.trim();
  if (!q) return null;
  return { AND: tokens(q).map((t) => ({ OR: [{ name: ci(t) }, { city: ci(t) }] })) };
}

export function userSearchWhere(raw: string | undefined | null): Prisma.UserWhereInput | null {
  const q = raw?.trim();
  if (!q) return null;
  return { AND: tokens(q).map((t) => ({ OR: [{ name: ci(t) }, { email: ci(t) }] })) };
}

/** Grouped results for the header search. Each group respects the viewer's permissions. */
export async function globalSearch(actor: Actor, q: string, opts: { vacancies: boolean; people: boolean }, take = 10) {
  const lw = leadSearchWhere(q);
  if (!lw) return null;
  const leadWhere = { AND: [leadScope(actor), lw] };
  const vw = vacancySearchWhere(q);
  const cw = clientSearchWhere(q);
  const uw = userSearchWhere(q);
  const [leads, leadCount, vacancies, vacancyCount, clients, people] = await Promise.all([
    prisma.candidate.findMany({ where: leadWhere, take, orderBy: { lastUpdated: "desc" }, include: { owner: { select: { name: true } } } }),
    prisma.candidate.count({ where: leadWhere }),
    opts.vacancies && vw ? prisma.vacancy.findMany({ where: vw, take, orderBy: { postedAt: "desc" }, include: { clientOrg: true, _count: { select: { submissions: true } } } }) : [],
    opts.vacancies && vw ? prisma.vacancy.count({ where: vw }) : 0,
    opts.vacancies && cw ? prisma.clientOrg.findMany({ where: cw, take, include: { _count: { select: { vacancies: true } } } }) : [],
    opts.people && uw ? prisma.user.findMany({ where: uw, take, include: { roles: { include: { team: true } } } }) : [],
  ]);
  return { leads, leadCount, vacancies, vacancyCount, clients, people };
}
