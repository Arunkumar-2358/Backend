import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route } from "@/http/route";
import { getProfile } from "./queries";
import { changeOwnPassword, updateOwnProfile } from "./profile";
import { setThemePreference } from "./preferences";

export async function profileRoutes(app: FastifyInstance) {
  route(app, "GET /v1/me/profile", {
    summary: "The signed-in user's profile, roles, weekly stats and recent activity",
    handler: async ({ actor }) => getProfile(actor),
  });

  route(app, "PUT /v1/me/profile", {
    summary: "Update the signed-in user's name and work mobile",
    body: z.object({ name: z.string().max(200), phone: z.string().max(20).optional() }),
    handler: async ({ actor, body }) => {
      await updateOwnProfile(actor, body);
      return { message: "Profile updated" };
    },
  });

  route(app, "PUT /v1/me/password", {
    summary: "Change the signed-in user's password",
    body: z.object({ current: z.string().max(200), next: z.string().max(200), confirm: z.string().max(200) }),
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    handler: async ({ actor, body }) => {
      await changeOwnPassword(actor, body);
      return { message: "Password changed" };
    },
  });

  route(app, "PUT /v1/me/theme", {
    summary: "Save the signed-in user's theme preference (light / dark / system)",
    body: z.object({ theme: z.string().max(20) }),
    handler: async ({ actor, body }) => {
      const theme = await setThemePreference(actor, body.theme);
      return { message: "Theme saved", theme };
    },
  });
}
