/**
 * Indian mobile normalisation (PLAN §3 stage 1): strip +91 / 0091 / leading 0,
 * spaces, dashes, dots and brackets. A valid result has exactly 10 digits.
 */
export function normalizeMobile(input: unknown): string {
  if (input === null || input === undefined) return "";
  let s = String(input).trim();
  // Excel sometimes gives numbers like 9876543210.0 or scientific notation
  if (/^\d+(\.0+)?$/.test(s)) s = s.replace(/\.0+$/, "");
  s = s.replace(/[\s\-().]/g, "");
  if (s.startsWith("+91")) s = s.slice(3);
  else if (s.startsWith("0091")) s = s.slice(4);
  else if (s.length === 12 && s.startsWith("91")) s = s.slice(2);
  else if (s.length === 11 && s.startsWith("0")) s = s.slice(1);
  return s;
}

export type MobileCheck = { ok: true; mobile: string } | { ok: false; mobile: string; reason: string };

export function validateMobile(input: unknown): MobileCheck {
  const mobile = normalizeMobile(input);
  if (!mobile) return { ok: false, mobile, reason: "Mobile number missing" };
  if (!/^\d+$/.test(mobile)) return { ok: false, mobile, reason: `Mobile contains non-digits: "${mobile}"` };
  if (mobile.length !== 10)
    return { ok: false, mobile, reason: `Mobile must be exactly 10 digits after normalisation (got ${mobile.length})` };
  return { ok: true, mobile };
}

export function maskMobile(mobile: string | null | undefined): string {
  if (!mobile) return "";
  return `+91 ••••••${mobile.slice(-4)}`;
}

export function formatMobile(mobile: string | null | undefined): string {
  if (!mobile) return "";
  return `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}`;
}
