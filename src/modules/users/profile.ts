import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";
import { validateMobile } from "@contracts/shared/phone";
import type { UserActor } from "@/platform/endpoint";

/** Self-service edit of the signed-in user's name and work mobile. */
export async function updateOwnProfile(actor: UserActor, input: { name?: string; phone?: string }) {
  const name = input.name?.trim();
  if (!name) throw new ValidationError("Name is required");
  const phoneRaw = input.phone?.trim();
  let phone: string | null = null;
  if (phoneRaw) {
    const m = validateMobile(phoneRaw);
    if (!m.ok) throw new ValidationError(m.reason);
    phone = m.mobile;
  }
  const before = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
  await prisma.user.update({ where: { id: actor.id }, data: { name, phone } });
  await audit(actor, "FIELD_EDIT", "user", actor.id, { name: { from: before.name, to: name }, phone: { from: before.phone ? "•••" : null, to: phone ? "•••" : null } });
}

/** Change the signed-in user's password after checking the current one. */
export async function changeOwnPassword(actor: UserActor, input: { current: string; next: string; confirm: string }) {
  const { current, next, confirm } = input;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
  if (!(await bcrypt.compare(current, user.passwordHash))) throw new ValidationError("Current password is incorrect");
  if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) throw new ValidationError("New password must be at least 8 characters with letters and numbers");
  if (next !== confirm) throw new ValidationError("New passwords do not match");
  if (next === current) throw new ValidationError("New password must be different");
  await prisma.user.update({ where: { id: actor.id }, data: { passwordHash: await bcrypt.hash(next, 10) } });
  await audit(actor, "SETTING_CHANGE", "user", actor.id, { passwordChanged: true });
}
