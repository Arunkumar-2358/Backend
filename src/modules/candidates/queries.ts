/** Read models for the leads pages (list / board / detail). */
import type { Prisma, Stage } from "@prisma/client";
import type { LeadDetail, LeadListQuery, LeadsPage } from "@contracts";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { maskMobile } from "@contracts/shared/phone";
import { NON_NT_SOURCES } from "@contracts/shared/fields";
import { PIPELINE, allowedTargets, ruleFor } from "@/modules/lifecycle/rules";
import { ForbiddenError, STAGE_OWNER_TEAMS, canEditLead, hasRole, isAdmin, isStageLeader, isStageTeamMember, leadScope, type Actor } from "@/lib/rbac";
import { notFound } from "@/lib/http-errors";
import { leadSearchWhere } from "@/modules/search/service";
import { decryptCandidate, logPiiView } from "./service";
import { profileChecklist } from "@/modules/scrutiny/service";
import { teamMembers } from "@/modules/users/assignment";
import { MAX_RESUME_BYTES, MAX_VIDEO_BYTES } from "@/modules/storage";

const PAGE_SIZE = 50;
const KANBAN_CARDS = 25;

/** Load a lead the actor is allowed to see, or fail as if it did not exist. */
export async function visibleLead(actor: Actor, id: string) {
  const lead = await prisma.candidate.findFirst({ where: { AND: [{ id }, leadScope(actor)] } });
  if (!lead) throw new ForbiddenError("Lead not found or not visible to you");
  return lead;
}

/** Whether the actor can currently see the lead. */
export async function isLeadVisible(actor: Actor, id: string) {
  return (await prisma.candidate.count({ where: { AND: [{ id }, leadScope(actor)] } })) > 0;
}

/** Leads & talent pool: filters shared by the list and the board (the board ignores `stage`). */
export async function leadsPage(actor: Extract<Actor, { kind: "user" }>, q: LeadListQuery): Promise<LeadsPage> {
  const base: Prisma.CandidateWhereInput[] = [leadScope(actor)];
  if (q.category) base.push({ mainCategory: q.category });
  if (q.owner === "me") base.push({ ownerUserId: actor.id });
  else if (q.owner === "none") base.push({ ownerUserId: null });
  else if (q.owner) base.push({ ownerUserId: q.owner });
  // Derive NT / non-NT from the source itself (isNtSource is only set when a source is given).
  if (q.source === "NT_ALL") base.push({ source: { notIn: [...NON_NT_SOURCES] } });
  else if (q.source === "NON_NT") base.push({ source: { in: [...NON_NT_SOURCES] } });
  else if (q.source) base.push({ source: q.source });
  if (q.cold) base.push({ isCold: true });
  const search = leadSearchWhere(q.q?.trim() || undefined);
  if (search) base.push(search);

  const ownersP = prisma.user.findMany({ where: { active: true, ownedLeads: { some: {} } }, select: { id: true, name: true }, orderBy: { name: "asc" } });

  if (q.view === "kanban") {
    const where: Prisma.CandidateWhereInput = { AND: base };
    const [owners, counts, columns] = await Promise.all([
      ownersP,
      prisma.candidate.groupBy({ by: ["stage"], where, _count: { _all: true } }),
      Promise.all(
        PIPELINE.map((s) =>
          prisma.candidate.findMany({
            where: { AND: [...base, { stage: s }] },
            select: { id: true, name: true, candidateCode: true, mainCategory: true, primarySpecialty: true, isCold: true, owner: { select: { name: true } } },
            orderBy: { stageChangedAt: "desc" },
            take: KANBAN_CARDS,
          }),
        ),
      ),
    ]);
    return {
      owners,
      list: null,
      board: {
        counts: Object.fromEntries(counts.map((c) => [c.stage, c._count._all])),
        columns: Object.fromEntries(PIPELINE.map((s, i) => [s, columns[i]])),
        cardsPerColumn: KANBAN_CARDS,
      },
    };
  }

  const page = q.page ?? 1;
  const where: Prisma.CandidateWhereInput = { AND: [...base, ...(q.stage ? [{ stage: q.stage }] : [])] };
  const [owners, total, rows] = await Promise.all([
    ownersP,
    prisma.candidate.count({ where }),
    prisma.candidate.findMany({
      where,
      include: { owner: { select: { name: true } } },
      orderBy: [{ nextFollowupAt: { sort: "asc", nulls: "last" } }, { lastUpdated: "desc" }],
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
  ]);
  return {
    owners,
    board: null,
    list: {
      total,
      page,
      pageSize: PAGE_SIZE,
      rows: rows.map((c) => ({
        id: c.id,
        candidateCode: c.candidateCode,
        name: c.name,
        source: c.source,
        mainCategory: c.mainCategory,
        primarySpecialty: c.primarySpecialty,
        jobTitle: c.jobTitle,
        currentLocation: c.currentLocation,
        preferredLocations: c.preferredLocations,
        stage: c.stage,
        isCold: c.isCold,
        profileCompletenessPct: c.profileCompletenessPct,
        nextFollowupAt: c.nextFollowupAt,
        owner: c.owner,
        mobileMasked: maskMobile(decrypt(c.mobileEnc)),
      })),
    },
  };
}

/**
 * Everything the lead page shows. Decrypts contact details and records the PII view
 * (DPDP access log). 404 = no such lead; 403 = the lead exists but is outside the actor's scope.
 */
export async function leadDetail(actor: Extract<Actor, { kind: "user" }>, id: string): Promise<LeadDetail> {
  const raw = await prisma.candidate.findFirst({
    where: { AND: [{ id }, leadScope(actor)] },
    include: { owner: { select: { id: true, name: true } }, verifiedBy: { select: { name: true } }, importBatch: { select: { id: true, fileName: true } } },
  });
  if (!raw) {
    const exists = await prisma.candidate.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw notFound("Lead not found");
    throw new ForbiddenError("This lead is outside what your role can see");
  }
  const c = decryptCandidate(raw);
  await logPiiView(actor, id);

  const canEdit = canEditLead(actor, c);
  const stageLeader = isStageLeader(actor, c.stage);
  const showAudit = hasRole(actor, "admin", "ta_coordinator");
  const admin = isAdmin(actor);

  const [checklist, tasks, attempts, history, submissions, messages, deletionRequests, audits, members, myOpenTask] = await Promise.all([
    profileChecklist(id),
    prisma.task.findMany({
      where: { candidateId: id, status: "OPEN" },
      select: { id: true, title: true, type: true, dueAt: true, assignee: { select: { name: true } } },
      orderBy: { dueAt: "asc" },
    }),
    prisma.contactAttempt.findMany({ where: { candidateId: id }, include: { byUser: { select: { name: true } } }, orderBy: { at: "desc" }, take: 100 }),
    prisma.leadStageHistory.findMany({ where: { candidateId: id }, include: { byUser: { select: { name: true } } }, orderBy: { at: "desc" } }),
    prisma.submission.findMany({
      where: { candidateId: id },
      include: {
        vacancy: { select: { id: true, code: true, title: true, clientOrg: { select: { name: true } } } },
        interviews: { orderBy: { scheduledAt: "desc" } },
        offers: { include: { joining: true }, orderBy: { sentAt: "desc" } },
      },
      orderBy: { submittedAt: "desc" },
    }),
    prisma.message.findMany({ where: { candidateId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
    admin ? prisma.dataDeletionRequest.findMany({ where: { candidateId: id }, orderBy: { requestedAt: "desc" } }) : Promise.resolve([]),
    showAudit ? prisma.auditLog.findMany({ where: { entityType: "candidate", entityId: id }, orderBy: { at: "desc" }, take: 60 }) : Promise.resolve([]),
    stageLeader && STAGE_OWNER_TEAMS[c.stage].length ? teamMembers(STAGE_OWNER_TEAMS[c.stage]) : Promise.resolve([]),
    prisma.task.count({ where: { candidateId: id, assigneeId: actor.id, status: "OPEN" } }),
  ]);

  // Strip encrypted columns and blind indexes; send the decrypted contact details the page shows.
  const { mobileEnc: _m, mobileHash: _mh, mobileLast4: _l4, altMobileEnc: _a, emailEnc: _e, emailHash: _eh, ...lead } = c;

  return {
    lead: { ...lead, mobile: c.mobile, altMobile: c.altMobile, email: c.email },
    checklist,
    can: {
      edit: canEdit,
      stageLeader,
      viewAudit: showAudit,
      admin,
      stagePanel: canEdit || isStageTeamMember(actor, c.stage),
      logContact: canEdit || myOpenTask > 0,
    },
    transitions: allowedTargets(c.stage).map((to: Stage) => {
      const rule = ruleFor(c.stage, to);
      return { to, performer: rule?.performer ?? null, description: rule?.description || null };
    }),
    tasks,
    attempts,
    history,
    submissions,
    messages,
    deletionRequests,
    audits,
    members: members.map((m) => ({ id: m.id, name: m.name, teams: [...new Set(m.roles.map((r) => r.team.code))] })),
    fileLimits: { resumeBytes: MAX_RESUME_BYTES, videoBytes: MAX_VIDEO_BYTES },
  };
}
