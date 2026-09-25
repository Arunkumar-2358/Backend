import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { canEditLead, leadScope, ForbiddenError } from "@/lib/rbac";
import { ValidationError } from "@/lib/errors";
import { requireUser } from "@/plugins/auth";
import { notFound } from "@/plugins/errors";
import { updateCandidate } from "@/modules/candidates/service";
import { storage, MAX_RESUME_BYTES, MAX_VIDEO_BYTES } from "@/modules/storage";

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  "3gp": "video/3gpp",
};
const RESUME_EXT = /\.(pdf|docx?)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|3gp)$/i;

export async function fileRoutes(app: FastifyInstance) {
  app.get("/v1/files/*", { schema: { tags: ["files"], summary: "Stream a stored resume / intro video (audited as a PII view)" } }, async (req, reply) => {
    const actor = await requireUser(req);
    const key = (req.params as { "*": string })["*"];
    if (!key || key.includes("..")) throw notFound();

    const owner = await prisma.candidate.findFirst({
      where: { OR: [{ resumeFileKey: key }, { introVideoKey: key }] },
      select: { id: true, resumeFileKey: true, resumeFileName: true },
    });
    if (!owner) throw notFound();
    const visible = await prisma.candidate.count({ where: { AND: [{ id: owner.id }, leadScope(actor)] } });
    if (!visible) throw new ForbiddenError("You cannot view files for this lead");

    let data: Buffer;
    try {
      data = await storage.get(key);
    } catch {
      throw notFound("File missing from storage");
    }
    const isResume = owner.resumeFileKey === key;
    await audit(actor, "VIEW_PII", "candidate", owner.id, { file: isResume ? "resume" : "intro_video" });

    const fileName = (isResume && owner.resumeFileName) || key.split("/").pop() || "file";
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const asciiName = fileName.replace(/[^\w.-]+/g, "_");
    return reply
      .header("content-type", MIME[ext] ?? "application/octet-stream")
      .header("content-disposition", `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .header("cache-control", "private, no-store")
      .send(data);
  });

  app.post(
    "/v1/leads/:id/files",
    { schema: { tags: ["leads"], summary: "Upload a resume or intro video (multipart: kind=resume|video, file)", params: z.object({ id: z.string() }) } },
    async (req) => {
      const actor = await requireUser(req);
      const { id } = req.params as { id: string };
      const lead = await prisma.candidate.findFirst({ where: { AND: [{ id }, leadScope(actor)] } });
      if (!lead) throw notFound("Lead not found");
      if (!canEditLead(actor, lead)) throw new ForbiddenError("You can only upload files to leads you own or that your team owns");
      if (!req.isMultipart()) throw new ValidationError("Expected multipart/form-data");

      let kind: string | undefined;
      let file: { name: string; type: string; data: Buffer } | undefined;
      for await (const part of req.parts()) {
        if (part.type === "field" && part.fieldname === "kind") kind = String(part.value);
        if (part.type === "file" && part.fieldname === "file") file = { name: part.filename, type: part.mimetype, data: await part.toBuffer() };
      }
      if (!file || file.data.length === 0) throw new ValidationError("Choose a file");

      if (kind === "resume") {
        if (!RESUME_EXT.test(file.name)) throw new ValidationError("Resume must be a PDF, DOC or DOCX file");
        if (file.data.length > MAX_RESUME_BYTES) throw new ValidationError("Resume must be 10 MB or smaller");
        const key = await storage.put("resumes", file.name, file.data);
        await updateCandidate(actor, id, { resumeFileKey: key, resumeFileName: file.name });
        return { message: "Resume uploaded" };
      }
      if (kind === "video") {
        if (!VIDEO_EXT.test(file.name) && !file.type.startsWith("video/")) throw new ValidationError("Intro video must be a video file (MP4, MOV, WebM)");
        if (file.data.length > MAX_VIDEO_BYTES) throw new ValidationError("Intro video must be 50 MB or smaller");
        const key = await storage.put("videos", file.name, file.data);
        await updateCandidate(actor, id, { introVideoKey: key });
        return { message: "Intro video uploaded" };
      }
      throw new ValidationError("Unknown file kind");
    },
  );
}
