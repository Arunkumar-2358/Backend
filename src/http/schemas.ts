import { z } from "zod";

/** Query-string boolean: "true" / "1" → true, "false" / "0" → false. */
export const queryBool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

export const idParam = z.object({ id: z.string().min(1) });
export const pageQuery = z.coerce.number().int().positive();
