import { describe, it, expect } from "vitest";
import { normalizeMobile, validateMobile } from "@contracts/shared/phone";
import { formatDate, startOfIstWeek, periodRange, addWorkingDays, istHour, parseFlexibleDate } from "@contracts/shared/dates";
import { encrypt, decrypt, blindIndex } from "@/lib/crypto";
import { completenessPct, missingMandatory } from "@contracts/shared/fields";
import { parseCategory, parseSource, autoMap } from "@/modules/import/pipeline";
import { withinWorkingDays } from "@/modules/redflags/service";
import { validateWeights, DEFAULT_CRITERIA } from "@/modules/eval/service";

describe("phone normalisation", () => {
  it.each([
    ["+91 98765 43210", "9876543210"],
    ["+91-98765-43210", "9876543210"],
    ["0091 9876543210", "9876543210"],
    ["919876543210", "9876543210"],
    ["09876543210", "9876543210"],
    ["(987) 654-3210", "9876543210"],
    [9876543210, "9876543210"],
    ["9876543210.0", "9876543210"],
  ])("%s → %s", (input, out) => {
    expect(normalizeMobile(input)).toBe(out);
    expect(validateMobile(input).ok).toBe(true);
  });
  it("rejects 9 and 11 digit numbers and junk", () => {
    expect(validateMobile("987654321")).toMatchObject({ ok: false, reason: expect.stringMatching(/got 9/) });
    expect(validateMobile("98765432101")).toMatchObject({ ok: false, reason: expect.stringMatching(/got 11/) });
    expect(validateMobile("98765abcde").ok).toBe(false);
    expect(validateMobile("").ok).toBe(false);
  });
});

describe("IST dates", () => {
  it("formats DD-MM-YYYY in IST", () => {
    expect(formatDate(new Date("2026-09-22T20:00:00Z"))).toBe("23-09-2026"); // 01:30 IST next day
  });
  it("weeks run Monday–Sunday IST", () => {
    const wk = startOfIstWeek(new Date("2026-09-27T17:00:00Z")); // Sun 22:30 IST
    expect(wk.toISOString()).toBe("2026-09-20T18:30:00.000Z"); // Mon 21-09 00:00 IST
    const m = periodRange("MONTH", new Date("2026-09-15T00:00:00Z"));
    expect(m.start.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(m.end.toISOString()).toBe("2026-09-30T18:30:00.000Z");
  });
  it("2 pm cut-off uses IST", () => {
    expect(istHour(new Date("2026-09-21T08:29:00Z"))).toBe(13);
    expect(istHour(new Date("2026-09-21T08:30:00Z"))).toBe(14);
  });
  it("working days skip Sundays and holidays", () => {
    const hol = new Set(["2026-10-02"]);
    // Thu 01-10 10:00 IST + 1 WD → Fri 02-10 is a holiday → Sat 03-10
    expect(formatDate(addWorkingDays(new Date("2026-10-01T04:30:00Z"), 1, hol))).toBe("03-10-2026");
    // Sat + 1 WD → Mon (Sunday skipped)
    expect(formatDate(addWorkingDays(new Date("2026-10-03T04:30:00Z"), 1, hol))).toBe("05-10-2026");
    expect(withinWorkingDays(new Date("2026-10-01T04:30:00Z"), new Date("2026-10-03T04:00:00Z"), 1, hol)).toBe(true);
    expect(withinWorkingDays(new Date("2026-10-01T04:30:00Z"), new Date("2026-10-03T05:00:00Z"), 1, hol)).toBe(false);
  });
  it("parses DD-MM-YYYY and Excel serials", () => {
    expect(formatDate(parseFlexibleDate("05-11-2026"))).toBe("05-11-2026");
    expect(formatDate(parseFlexibleDate(46331))).toBe("05-11-2026");
  });
});

describe("PII crypto", () => {
  it("round-trips and blind-indexes deterministically", () => {
    const c = encrypt("9876543210");
    expect(c).not.toContain("9876543210");
    expect(decrypt(c)).toBe("9876543210");
    expect(blindIndex("A@B.com")).toBe(blindIndex("a@b.com "));
  });
});

describe("profile completeness", () => {
  it("counts mandatory fields", () => {
    const c = { name: "x", mobile: "9876543210", email: null, altMobile: null, preferredLocations: [], consentRecordStoreShare: false };
    expect(missingMandatory(c, ["name", "email", "preferredLocations", "consentRecordStoreShare"])).toEqual(["email", "preferredLocations", "consentRecordStoreShare"]);
    expect(completenessPct(c, ["name", "mobile", "email", "preferredLocations"])).toBe(50);
  });
});

describe("import parsing", () => {
  it("infers categories and sources", () => {
    expect(parseCategory("Staff Nurse")).toBe("NURSE");
    expect(parseCategory("B.Pharm")).toBe("PHARMACY");
    expect(parseCategory("MBBS")).toBe("DOCTOR");
    expect(parseCategory("Lab technician")).toBe("ALLIED");
    expect(parseCategory("")).toBeNull();
    expect(parseSource("Naukri.com", "OTHER")).toBe("NAUKRI");
    expect(parseSource("", "NT")).toBe("NT");
  });
  it("auto-maps CV Register and Zoho headers", () => {
    expect(autoMap(["Candidate Name", "Mobile No", "Email ID", "Main Category"])).toEqual({ "Candidate Name": "name", "Mobile No": "mobile", "Email ID": "email", "Main Category": "mainCategory" });
    expect(autoMap(["First Name", "Last Name", "City"], "Zoho Recruit export")).toEqual({ "First Name": "firstName", "Last Name": "lastName", City: "currentLocation" });
  });
});

describe("scorecard weights", () => {
  it("the default template totals 100", () => expect(validateWeights(DEFAULT_CRITERIA)).toEqual([]));
  it("blocks totals other than 100", () => {
    expect(validateWeights([{ name: "A", weightPct: 60 }, { name: "B", weightPct: 30 }])[0]).toMatch(/total 90%/);
    expect(validateWeights([{ name: "A", weightPct: 60 }, { name: "B", children: [{ name: "b1", weightPct: 30 }, { name: "b2", weightPct: 20 }] }])[0]).toMatch(/110%/);
    expect(validateWeights([{ name: "A", weightPct: 100 }, { name: "B", weightPct: 0 }]).join()).toMatch(/greater than 0/);
  });
});

import { maskPii, maskPiiDeep } from "@/lib/pii-scrub";

describe("PII scrubbing for error reports", () => {
  it("masks mobiles and emails in free text, leaving ids and dates alone", () => {
    expect(maskPii("Invalid mobile 9876543210 for priya.s@example.com")).toBe("Invalid mobile [mobile] for [email]");
    expect(maskPii("dup of +91 98765-43210 / 098765 43210")).toBe("dup of [mobile] / [mobile]");
    expect(maskPii("lead cmuhx123 on 2026-09-26, VAC00012")).toBe("lead cmuhx123 on 2026-09-26, VAC00012");
    expect(maskPiiDeep({ a: ["x@y.io"], b: { c: "9123456789" }, n: 5 })).toEqual({ a: ["[email]"], b: { c: "[mobile]" }, n: 5 });
  });
});
