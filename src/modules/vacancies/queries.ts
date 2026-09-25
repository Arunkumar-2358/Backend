import type { MainCategory, Prisma, Stage, TeamCode, VacancyStatus } from "@prisma/client";
import type { RecruitmentBoard, VacancyDetail, VacancyList } from "@contracts";
import { prisma } from "@/lib/db";
import { now, DAY } from "@/lib/clock";
import { getAllSettings } from "@/lib/settings";
import { hasRole, type Actor } from "@/lib/rbac";
import { MAIN_CATEGORIES } from "@contracts/shared/fields";
import { vacancySearchWhere } from "@/modules/search/service";
import { notFound } from "@/plugins/errors";
import { matchesFor, sourcingStats } from "./service";

const PAGE_SIZE = 25;
const STATUSES: VacancyStatus[] = ["OPEN", "PENDING", "CLOSED"];
const TEAMS: TeamCode[] = ["T3A", "T3B", "T3C"];

export type VacancyListQuery = { q?: string; status?: string; category?: string; team?: string; org?: string; mine?: boolean; page?: number };

/** Vacancies list page: filters, one page of rows with sourcing stats, and the client-org filter options. */
export async function listVacancies(actor: Extract<Actor, { kind: "user" }>, sp: VacancyListQuery): Promise<VacancyList> {
  const page = Math.max(1, Math.floor(sp.page ?? 1) || 1);
  const search = vacancySearchWhere(sp.q);
  const filters: Prisma.VacancyWhereInput = {
    ...(STATUSES.includes(sp.status as VacancyStatus) ? { status: sp.status as VacancyStatus } : {}),
    ...((MAIN_CATEGORIES as readonly string[]).includes(sp.category ?? "") ? { category: sp.category as MainCategory } : {}),
    ...(TEAMS.includes(sp.team as TeamCode) ? { routedTeam: sp.team as TeamCode } : {}),
    ...(sp.org ? { clientOrgId: sp.org } : {}),
    ...(sp.mine ? { OR: [{ recruiterId: actor.id }, { sourcerId: actor.id }] } : {}),
  };
  const where: Prisma.VacancyWhereInput = search ? { AND: [filters, search] } : filters;
  const [total, vacancies, orgs, settings] = await Promise.all([
    prisma.vacancy.count({ where }),
    prisma.vacancy.findMany({
      where,
      include: { clientOrg: true, recruiter: { select: { name: true } }, sourcer: { select: { name: true } }, submissions: { select: { isNtSource: true, submittedAt: true } } },
      orderBy: [{ status: "asc" }, { postedAt: "desc" }],
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    prisma.clientOrg.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    getAllSettings(),
  ]);
  return {
    total,
    page,
    pageSize: PAGE_SIZE,
    vacancies: vacancies.map(({ submissions, ...v }) => ({ ...v, stats: sourcingStats({ ...v, submissions }, settings.cvTargetPerVacancy) })),
    orgs,
    cvTargetPerVacancy: settings.cvTargetPerVacancy,
    cvMinTeam3bc: settings.cvMinTeam3bc,
  };
}

/** Vacancy page: details, sourcing stats, ranked matches and submissions (with the latest interview). */
export async function vacancyDetail(id: string): Promise<VacancyDetail> {
  const v = await prisma.vacancy.findUnique({
    where: { id },
    include: {
      clientOrg: true,
      recruiter: { select: { name: true } },
      sourcer: { select: { name: true } },
      submissions: {
        include: {
          candidate: { select: { id: true, name: true, candidateCode: true, stage: true } },
          submittedBy: { select: { name: true } },
          interviews: { orderBy: { scheduledAt: "desc" }, take: 1 },
        },
        orderBy: { submittedAt: "asc" },
      },
    },
  });
  if (!v) throw notFound("Vacancy not found");
  const settings = await getAllSettings();
  const stats = sourcingStats(v, settings.cvTargetPerVacancy);
  const matches = v.status === "CLOSED" ? [] : await matchesFor(v.id, 50);
  return {
    vacancy: v,
    stats,
    cvMinTeam3bc: settings.cvMinTeam3bc,
    matches: matches.map(({ candidate: c, score, breakdown }) => ({
      score,
      breakdown,
      candidate: {
        id: c.id,
        name: c.name,
        candidateCode: c.candidateCode,
        primarySpecialty: c.primarySpecialty,
        experienceYears: c.experienceYears,
        expectedCtcLakhs: c.expectedCtcLakhs,
        noticePeriodDays: c.noticePeriodDays,
        preferredLocations: c.preferredLocations,
        isNtSource: c.isNtSource,
        consentRecordStoreShare: c.consentRecordStoreShare,
      },
    })),
  };
}

const BOARD_STAGES: Stage[] = ["SOURCED", "SELECTED", "JOINED"];

/**
 * Interviews → joining board. Team 3 leaders and admin see every Team 3a/3b/3c
 * vacancy; everyone else only the vacancies they recruit for.
 */
export async function recruitmentBoard(actor: Extract<Actor, { kind: "user" }>): Promise<RecruitmentBoard> {
  const isLeader = hasRole(actor, "team3_leader", "admin");
  const vacScope: Prisma.VacancyWhereInput = isLeader ? { routedTeam: { in: ["T3A", "T3B", "T3C"] } } : { recruiterId: actor.id };
  const since = new Date(now().getTime() - 30 * DAY);
  const [leads, settings, outcomes] = await Promise.all([
    prisma.candidate.findMany({
      where: { stage: { in: BOARD_STAGES }, anonymizedAt: null, submissions: { some: { vacancy: vacScope } } },
      select: {
        id: true,
        name: true,
        candidateCode: true,
        stage: true,
        stageChangedAt: true,
        submissions: {
          where: { vacancy: vacScope },
          include: {
            vacancy: { include: { clientOrg: { select: { name: true } } } },
            interviews: { orderBy: { scheduledAt: "desc" } },
            offers: { orderBy: { sentAt: "desc" }, include: { joining: true } },
          },
          orderBy: { submittedAt: "asc" },
        },
      },
      orderBy: { stageChangedAt: "asc" },
      take: 300,
    }),
    getAllSettings(),
    prisma.leadStageHistory.findMany({
      where: { toStage: { in: ["SUCCESSFUL", "DROPPED"] }, at: { gte: since }, candidate: { submissions: { some: { vacancy: vacScope } } } },
      include: { candidate: { select: { id: true, name: true, candidateCode: true, dropReason: true } }, byUser: { select: { name: true } } },
      orderBy: { at: "desc" },
      take: 50,
    }),
  ]);
  return { isLeader, leads, reminderHours: settings.interviewReminderOffsetsHours, outcomes };
}
