import { Controller, Module } from "@nestjs/common";
import { z } from "zod";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { sessionIdOf } from "@/platform/auth";
import { revokeUserSessions } from "@/modules/auth/sessions";
import { getProfile } from "./queries";
import { changeOwnPassword, updateOwnProfile } from "./profile";
import { setThemePreference } from "./preferences";

@Controller()
export class ProfileController {
  @Endpoint("GET /v1/me/profile", {
    summary: "The signed-in user's profile, roles, weekly stats and recent activity",
  })
  async profile({ actor }: Ctx<"GET /v1/me/profile">) {
    return getProfile(actor);
  }

  @Endpoint("PUT /v1/me/profile", {
    summary: "Update the signed-in user's name and work mobile",
    body: z.object({ name: z.string().max(200), phone: z.string().max(20).optional() }),
  })
  async updateProfile({ actor, body }: Ctx<"PUT /v1/me/profile">) {
    await updateOwnProfile(actor, body);
    return { message: "Profile updated" };
  }

  @Endpoint("PUT /v1/me/password", {
    summary: "Change the signed-in user's password",
    body: z.object({ current: z.string().max(200), next: z.string().max(200), confirm: z.string().max(200) }),
    throttle: { limit: 10, ttlMs: 60_000 },
  })
  async changePassword({ actor, body, req }: Ctx<"PUT /v1/me/password">) {
    await changeOwnPassword(actor, body);
    // A changed password must end every other device's session (a stolen token dies with the old password).
    await revokeUserSessions(actor.id, "password changed", { exceptFamilyId: sessionIdOf(req) });
    return { message: "Password changed" };
  }

  @Endpoint("PUT /v1/me/theme", {
    summary: "Save the signed-in user's theme preference (light / dark / system)",
    body: z.object({ theme: z.string().max(20) }),
  })
  async setTheme({ actor, body }: Ctx<"PUT /v1/me/theme">) {
    const theme = await setThemePreference(actor, body.theme);
    return { message: "Theme saved", theme };
  }
}

@Module({ controllers: [ProfileController] })
export class ProfileModule {}
