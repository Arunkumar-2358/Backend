import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/db";
import { leadSearchWhere, vacancySearchWhere, globalSearch } from "@/modules/search/service";
import { leadScope } from "@/lib/rbac";
import { resetDb, as, newLead } from "./helpers";
import { makeVacancy } from "./drive";

let ids: Record<string, string> = {};

beforeAll(async () => {
  await resetDb();
  const a = await newLead({ name: "Aarthi Reddy", mobile: "9848011111", email: "aarthi@example.com", currentLocation: "Hyderabad", primarySpecialty: "ICU", jobTitle: "Staff Nurse", registrationNumber: "TSNC-4521" });
  const b = await newLead({ name: "Bhargav Das", mobile: "9848022222", email: "bhargav@example.com", mainCategory: "PHARMACY", jobTitle: "Pharmacist", primarySpecialty: "Retail", currentLocation: "Chennai", preferredLocations: ["Chennai"] });
  const c = await newLead({ name: "Chitra Iyer", mobile: "9848033333", email: "chitra@example.com", currentLocation: "Pune", preferredLocations: ["Hyderabad", "Pune"], primarySpecialty: "OT" });
  ids = { a: a.id, b: b.id, c: c.id };
  await makeVacancy({ title: "Staff Nurse – ICU", location: "Hyderabad" });
  await makeVacancy({ title: "Hospital Pharmacist", category: "PHARMACY", specialty: "Hospital pharmacy", location: "Bengaluru" }, "EXISTING");
});

const find = async (q: string) =>
  (await prisma.candidate.findMany({ where: leadSearchWhere(q)!, select: { id: true } })).map((r) => Object.entries(ids).find(([, v]) => v === r.id)?.[0]).sort();

describe("lead search", () => {
  it.each([
    ["aarthi", ["a"]],
    ["REDDY", ["a"]],
    ["NTC000002", ["b"]],
    ["2", ["b"]], // code ending in 2
    ["+91 98480 11111", ["a"]], // full mobile, any format
    ["9848022222", ["b"]],
    ["3333", ["c"]], // last 4 digits
    ["chitra@example.com", ["c"]], // exact email
    ["Hyderabad", ["a", "c"]], // current or preferred location
    ["nurse hyderabad", ["a", "c"]], // every word must match (category NURSE + location)
    ["pharmacist", ["b"]],
    ["pharmacy", ["b"]],
    ["icu", ["a"]],
    ["tsnc-4521", ["a"]], // registration number
    ["zzzz", []],
  ])("%s", async (q, expected) => {
    expect(await find(q)).toEqual(expected);
  });

  it("does not match every code for a 4-digit query like 0000", async () => {
    expect(await find("0000")).toEqual([]);
  });

  it("empty query means no filter", () => {
    expect(leadSearchWhere("  ")).toBeNull();
  });
});

describe("vacancy and global search", () => {
  it("finds vacancies by title, location, client and category", async () => {
    const titles = async (q: string) => (await prisma.vacancy.findMany({ where: vacancySearchWhere(q)!, select: { title: true } })).map((v) => v.title).sort();
    expect(await titles("icu")).toEqual(["Staff Nurse – ICU"]);
    expect(await titles("bengaluru")).toEqual(["Hospital Pharmacist"]);
    expect(await titles("carewell")).toEqual(["Hospital Pharmacist"]);
    expect(await titles("nurse hyderabad")).toEqual(["Staff Nurse – ICU"]);
  });

  it("global search respects lead visibility", async () => {
    const coord = await globalSearch(await as("sumitha"), "hyderabad", { vacancies: true, people: false });
    expect(coord!.leadCount).toBe(2);
    expect(coord!.vacancies.map((v) => v.title)).toEqual(["Staff Nurse – ICU"]);
    const harsha = await globalSearch(await as("harsha"), "hyderabad", { vacancies: true, people: false });
    const visible = await prisma.candidate.count({ where: { AND: [leadScope(await as("harsha")), leadSearchWhere("hyderabad")!] } });
    expect(harsha!.leadCount).toBe(visible);
    expect(harsha!.leadCount).toBe(0); // recruiter doesn't own these Mapping-stage leads
  });
});
