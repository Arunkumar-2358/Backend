export const THEME_PREFS = ["light", "dark", "system"] as const;
export type ThemePref = (typeof THEME_PREFS)[number];

export function parseThemePref(v: unknown): ThemePref {
  return THEME_PREFS.includes(v as ThemePref) ? (v as ThemePref) : "system";
}
