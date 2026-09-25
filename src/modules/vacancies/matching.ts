import type { Candidate, Vacancy } from "@prisma/client";

export type MatchBreakdown = { specialty: number; experience: number; location: number; ctc: number; notice: number };
export type Match = { candidate: Candidate; score: number; breakdown: MatchBreakdown };

const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
const contains = (a?: string | null, b?: string | null) => !!a && !!b && (a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase()));

/**
 * Match score out of 100 (M4): specialty 30, experience 20, location 20
 * (by preference priority), expected CTC 20, notice period 10.
 * Category is a hard filter applied by the caller.
 */
export function scoreMatch(c: Candidate, v: Vacancy): { score: number; breakdown: MatchBreakdown } {
  let specialty = 0;
  if (!v.specialty) specialty = 30;
  else if (eq(c.primarySpecialty, v.specialty)) specialty = 30;
  else if (contains(c.primarySpecialty, v.specialty) || c.secondarySkills.some((s) => contains(s, v.specialty))) specialty = 15;

  let experience = 0;
  const minExp = v.minExperienceYears ?? 0;
  if (c.experienceYears === null || c.experienceYears === undefined) experience = minExp === 0 ? 10 : 0;
  else if (c.experienceYears >= minExp) experience = 20;
  else experience = Math.max(0, Math.round(20 * (c.experienceYears / Math.max(minExp, 0.5)) * 0.75));

  let location = 0;
  const idx = c.preferredLocations.findIndex((l) => eq(l, v.location) || contains(l, v.location));
  if (idx >= 0) location = Math.max(8, 20 - idx * 4);
  else if (eq(c.currentLocation, v.location) || contains(c.currentLocation, v.location)) location = 12;
  else if (c.preferredLocations.some((l) => /any|pan india|anywhere/i.test(l))) location = 8;

  let ctc = 0;
  if (c.expectedCtcLakhs === null || c.expectedCtcLakhs === undefined || v.ctcMaxLakhs === null || v.ctcMaxLakhs === undefined) ctc = 10;
  else if (c.expectedCtcLakhs <= v.ctcMaxLakhs) ctc = 20;
  else if (c.expectedCtcLakhs <= v.ctcMaxLakhs * 1.2) ctc = 10;

  let notice = 0;
  if (v.maxNoticeDays === null || v.maxNoticeDays === undefined) notice = 10;
  else if (c.noticePeriodDays !== null && c.noticePeriodDays !== undefined && c.noticePeriodDays <= v.maxNoticeDays) notice = 10;
  else if (c.noticePeriodDays !== null && c.noticePeriodDays !== undefined && c.noticePeriodDays <= v.maxNoticeDays * 2) notice = 5;

  const breakdown = { specialty, experience, location, ctc, notice };
  return { score: specialty + experience + location + ctc + notice, breakdown };
}

export function rankMatches(cands: Candidate[], v: Vacancy): Match[] {
  return cands
    .filter((c) => c.mainCategory === v.category)
    .map((c) => ({ candidate: c, ...scoreMatch(c, v) }))
    .sort((a, b) => b.score - a.score || (a.candidate.expectedCtcLakhs ?? 0) - (b.candidate.expectedCtcLakhs ?? 0));
}
