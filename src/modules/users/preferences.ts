import { prisma, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";
import { THEME_PREFS, type ThemePref } from "@/lib/theme";
import type { Actor } from "@/lib/rbac";

export async function setThemePreference(actor: Extract<Actor, { kind: "user" }>, pref: string, db: Tx = prisma): Promise<ThemePref> {
  if (!THEME_PREFS.includes(pref as ThemePref)) throw new ValidationError(`Unknown theme "${pref}"`);
  const before = await db.user.findUniqueOrThrow({ where: { id: actor.id }, select: { theme: true } });
  if (before.theme !== pref) {
    await db.user.update({ where: { id: actor.id }, data: { theme: pref } });
    await audit(actor, "SETTING_CHANGE", "user", actor.id, { theme: { from: before.theme, to: pref } }, db);
  }
  return pref as ThemePref;
}
