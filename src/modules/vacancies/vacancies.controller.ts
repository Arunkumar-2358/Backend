import { z } from "zod";
import { InterviewMode, type ClientOrgType, type MainCategory } from "@prisma/client";
import { Controller, Module } from "@nestjs/common";
import { Endpoint, type Ctx } from "@/platform/endpoint";
import { idParam, pageQuery, queryBool } from "@/http/schemas";
import { prisma } from "@/lib/db";
import { now } from "@/lib/clock";
import { audit } from "@/lib/audit";
import { GateError, ValidationError } from "@/lib/errors";
import { ForbiddenError, hasRole } from "@/lib/rbac";
import { MAIN_CATEGORIES } from "@contracts/shared/fields";
import { ROUTING } from "@contracts/shared/labels";
import { TEAM_LABEL } from "@contracts/shared/c-vacancy-labels";
import {
  completeFormalities,
  confirmJoiningDate,
  declineOffer,
  recordInterviewOutcome,
  recordJoining,
  recordRetentionCheck,
  rescheduleInterview,
  scheduleInterview,
  sendOffer,
} from "@/modules/interviews/service";
import { calibrateVacancy, createVacancy, decideSubmission, inviteToApply, setVacancyStatus, submitCandidate } from "./service";
import { listVacancies, recruitmentBoard, vacancyDetail } from "./queries";

const ORG_TYPES: ClientOrgType[] = ["GENERAL", "EXISTING", "FREE_TRIAL"];
const TEAMS_2_3 = ["admin", "sourcer", "team2_leader", "recruiter", "team3_leader"] as const;
const MODES = Object.values(InterviewMode) as string[];

const optStr = z.string().trim().max(500).optional();
const optNum = z.number().finite().optional();
const note = z.string().trim().max(2000).optional();

function errText(e: unknown): string {
  if (e instanceof GateError) return `gate not met — ${e.failures.join("; ")}`;
  if (e instanceof Error) return e.message;
  return String(e).replace(/^\w*Error: /, "");
}

@Controller()
export class VacanciesController {
  // ---- Vacancies ---------------------------------------------------------

  @Endpoint("GET /v1/vacancies", {
    summary: "Vacancies list with filters, sourcing stats and client-org options",
    query: z.object({
      q: z.string().max(200).optional(),
      status: z.string().max(40).optional(),
      category: z.string().max(40).optional(),
      team: z.string().max(40).optional(),
      org: z.string().max(100).optional(),
      mine: queryBool.optional(),
      page: pageQuery.optional(),
    }),
  })
  async getVacancies({ actor, query }: Ctx<"GET /v1/vacancies">) {
    return listVacancies(actor, query ?? {});
  }

  @Endpoint("POST /v1/vacancies", {
    summary: "Create a vacancy (routes to Team 3a/3b/3c by client org type)",
    body: z.object({
      clientOrgId: optStr,
      title: optStr,
      category: optStr,
      specialty: optStr,
      location: optStr,
      minExperienceYears: optNum,
      ctcMinLakhs: optNum,
      ctcMaxLakhs: optNum,
      maxNoticeDays: optNum,
      openings: optNum,
      postedAt: z.coerce.date().optional(),
    }),
  })
  async postVacancies({ actor, body }: Ctx<"POST /v1/vacancies">) {
    const { clientOrgId, title, category, location, ctcMinLakhs: ctcMin, ctcMaxLakhs: ctcMax } = body;
    if (!clientOrgId) throw new ValidationError("Choose a client organisation");
    if (!title) throw new ValidationError("Title is required");
    if (!category || !(MAIN_CATEGORIES as readonly string[]).includes(category)) throw new ValidationError("Choose a category");
    if (!location) throw new ValidationError("Location is required");
    if (ctcMin !== undefined && ctcMax !== undefined && ctcMin > ctcMax) throw new ValidationError("CTC minimum is above the maximum");
    const v = await createVacancy(actor, {
      clientOrgId,
      title,
      category: category as MainCategory,
      specialty: body.specialty || null,
      location,
      minExperienceYears: body.minExperienceYears ?? null,
      ctcMinLakhs: ctcMin ?? null,
      ctcMaxLakhs: ctcMax ?? null,
      maxNoticeDays: body.maxNoticeDays ?? null,
      openings: Math.max(1, Math.round(body.openings ?? 1)),
      postedAt: body.postedAt,
    });
    return { message: `Created ${v.code}`, id: v.id };
  }

  @Endpoint("GET /v1/vacancies/client-orgs", {
    summary: "Client organisations for the vacancy intake form (Teams 2/3 only)",
  })
  async getVacanciesClientOrgs({ actor }: Ctx<"GET /v1/vacancies/client-orgs">) {
    if (!hasRole(actor, ...TEAMS_2_3)) throw new ForbiddenError("Only Teams 2 and 3 can add vacancies");
    return prisma.clientOrg.findMany({ orderBy: { name: "asc" } });
  }

  @Endpoint("POST /v1/vacancies/client-orgs", {
    summary: "Add a client organisation",
    body: z.object({ name: optStr, type: optStr, city: optStr }),
  })
  async postVacanciesClientOrgs({ actor, body }: Ctx<"POST /v1/vacancies/client-orgs">) {
    if (!hasRole(actor, ...TEAMS_2_3)) throw new ForbiddenError("Only Teams 2/3 can add client organisations");
    const { name } = body;
    const type = body.type as ClientOrgType | undefined;
    if (!name) throw new ValidationError("Organisation name is required");
    if (!type || !ORG_TYPES.includes(type)) throw new ValidationError("Choose an organisation type");
    if (await prisma.clientOrg.findUnique({ where: { name } })) throw new ValidationError(`"${name}" already exists`);
    const org = await prisma.clientOrg.create({ data: { name, type, city: body.city || undefined, createdAt: now() } });
    await audit(actor, "CREATE", "client_org", org.id, { name, type });
    return { message: `Added ${name} — vacancies will route to Team ${TEAM_LABEL[ROUTING[type]]}`, id: org.id };
  }

  @Endpoint("GET /v1/vacancies/{id}", {
    summary: "Vacancy details, sourcing stats, ranked matching Active leads and submissions",
    params: idParam,
  })
  async getVacanciesDetail({ params }: Ctx<"GET /v1/vacancies/{id}">) {
    return vacancyDetail(params.id);
  }

  @Endpoint("POST /v1/vacancies/{id}/calibrate", {
    summary: "Mark the vacancy calibrated",
    params: idParam,
  })
  async postVacanciesCalibrate({ actor, params }: Ctx<"POST /v1/vacancies/{id}/calibrate">) {
    if (!hasRole(actor, ...TEAMS_2_3)) throw new ForbiddenError();
    await calibrateVacancy(actor, params.id);
    return { message: "Vacancy calibrated" };
  }

  @Endpoint("POST /v1/vacancies/{id}/status", {
    summary: "Set the vacancy status (open / pending / closed)",
    params: idParam,
    body: z.object({ status: optStr }),
  })
  async postVacanciesStatus({ actor, params, body }: Ctx<"POST /v1/vacancies/{id}/status">) {
    if (!hasRole(actor, ...TEAMS_2_3)) throw new ForbiddenError();
    const { status } = body;
    if (status !== "OPEN" && status !== "PENDING" && status !== "CLOSED") throw new ValidationError("Choose a status");
    await setVacancyStatus(actor, params.id, status);
    return { message: `Status set to ${status.toLowerCase()}` };
  }

  @Endpoint("POST /v1/vacancies/{id}/submissions", {
    summary: "Submit matched CVs to the recruiter (Active → Sourced); partial failures are reported",
    params: idParam,
    body: z.object({ candidates: z.array(z.object({ id: z.string().min(1), matchScore: z.number().finite().nullable().optional() })).max(500) }),
  })
  async postVacanciesSubmissions({ actor, params, body }: Ctx<"POST /v1/vacancies/{id}/submissions">) {
    if (!body.candidates.length) throw new ValidationError("Select at least one candidate");
    const rows = await prisma.candidate.findMany({ where: { id: { in: body.candidates.map((c) => c.id) } }, select: { id: true, name: true, candidateCode: true } });
    const labels = new Map(rows.map((c) => [c.id, `${c.candidateCode} ${c.name}`]));
    let ok = 0;
    const failures: string[] = [];
    for (const c of body.candidates) {
      try {
        await submitCandidate(actor, params.id, c.id, c.matchScore ?? null);
        ok++;
      } catch (e) {
        failures.push(`${labels.get(c.id) ?? c.id}: ${errText(e)}`);
      }
    }
    if (failures.length) throw new ValidationError(`${ok} CV(s) submitted; ${failures.length} failed — ${failures.join(" | ")}`);
    return { message: `${ok} CV(s) submitted to the recruiter` };
  }

  @Endpoint("POST /v1/vacancies/{id}/invites", {
    summary: "Invite matched Active leads to apply",
    params: idParam,
    body: z.object({ candidateIds: z.array(z.string().min(1)).max(500), channel: optStr }),
  })
  async postVacanciesInvites({ actor, params, body }: Ctx<"POST /v1/vacancies/{id}/invites">) {
    if (!body.candidateIds.length) throw new ValidationError("Select at least one candidate");
    const { channel } = body;
    if (channel !== "WHATSAPP" && channel !== "SMS" && channel !== "EMAIL") throw new ValidationError("Choose a channel");
    const res = await inviteToApply(actor, params.id, body.candidateIds, channel);
    if (res.errors.length) throw new ValidationError(`${res.sent} invite(s) sent; ${res.errors.length} failed: ${res.errors.map((e) => e.replace(/^\w*Error: /, "")).join("; ")}`);
    return { message: `${res.sent} invite(s) sent by ${channel.toLowerCase()}` };
  }

  @Endpoint("POST /v1/vacancies/submissions/{id}/decision", {
    summary: "Shortlist or reject a submitted CV",
    params: idParam,
    body: z.object({ decision: optStr }),
  })
  async postVacanciesSubmissionsDecision({ actor, params, body }: Ctx<"POST /v1/vacancies/submissions/{id}/decision">) {
    const { decision } = body;
    if (decision !== "SHORTLISTED" && decision !== "REJECTED") throw new ValidationError("Choose a decision");
    await decideSubmission(actor, params.id, decision);
    return { message: decision === "SHORTLISTED" ? "Shortlisted" : "Rejected" };
  }

  // ---- Recruitment board (interviews → offers → joining → retention) ----

  @Endpoint("GET /v1/recruitment", {
    summary: "Interviews → joining board: sourced, selected and joined leads plus recent outcomes",
  })
  async getRecruitment({ actor }: Ctx<"GET /v1/recruitment">) {
    return recruitmentBoard(actor);
  }

  @Endpoint("POST /v1/recruitment/interviews", {
    summary: "Schedule and communicate an interview",
    body: z.object({ submissionId: optStr, scheduledAt: z.coerce.date(), mode: z.string().max(20).optional(), notes: note }),
  })
  async postRecruitmentInterviews({ actor, body }: Ctx<"POST /v1/recruitment/interviews">) {
    if (!body.submissionId) throw new ValidationError("Choose the vacancy / submission");
    const mode = body.mode || "IN_PERSON";
    if (!MODES.includes(mode)) throw new ValidationError("Unknown interview mode");
    await scheduleInterview(actor, body.submissionId, { scheduledAt: body.scheduledAt, mode: mode as InterviewMode, notes: body.notes || undefined });
    return { message: "Interview scheduled and communicated — reminders at T-24h and T-2h are queued" };
  }

  @Endpoint("POST /v1/recruitment/interviews/{id}/reschedule", {
    summary: "Reschedule an interview (re-queues reminders)",
    params: idParam,
    body: z.object({ scheduledAt: z.coerce.date() }),
  })
  async postRecruitmentInterviewsReschedule({ actor, params, body }: Ctx<"POST /v1/recruitment/interviews/{id}/reschedule">) {
    if (body.scheduledAt.getTime() <= now().getTime()) throw new ValidationError("New interview time must be in the future");
    await rescheduleInterview(actor, params.id, body.scheduledAt);
    return { message: "Interview rescheduled — reminders re-queued" };
  }

  @Endpoint("POST /v1/recruitment/interviews/{id}/outcome", {
    summary: "Record an interview outcome (selected / rejected / no-show / cancelled)",
    params: idParam,
    body: z.object({ outcome: optStr, notes: note }),
  })
  async postRecruitmentInterviewsOutcome({ actor, params, body }: Ctx<"POST /v1/recruitment/interviews/{id}/outcome">) {
    const map = {
      SELECTED: { status: "ATTENDED", result: "SELECTED" },
      REJECTED: { status: "ATTENDED", result: "REJECTED" },
      NO_SHOW: { status: "NO_SHOW" },
      CANCELLED: { status: "CANCELLED" },
    } as const;
    const { outcome } = body;
    if (!outcome || !(outcome in map)) throw new ValidationError("Choose an outcome");
    await recordInterviewOutcome(actor, params.id, { ...map[outcome as keyof typeof map], notes: body.notes || undefined });
    return {
      message:
        outcome === "SELECTED" ? "Selected — lead moved to Selected" : outcome === "CANCELLED" ? "Interview cancelled" : "Outcome recorded (the lead is dropped if it has no other live submissions)",
    };
  }

  @Endpoint("POST /v1/recruitment/offers", {
    summary: "Send an offer to a Selected lead",
    body: z.object({ submissionId: optStr, ctcLakhs: z.number().finite().nullable().optional(), joiningDate: z.coerce.date().nullable().optional() }),
  })
  async postRecruitmentOffers({ actor, body }: Ctx<"POST /v1/recruitment/offers">) {
    if (!body.submissionId) throw new ValidationError("Choose the submission");
    await sendOffer(actor, body.submissionId, { ctcLakhs: body.ctcLakhs ?? null, joiningDate: body.joiningDate ?? null });
    return { message: "Offer sent — follow-up task created" };
  }

  @Endpoint("POST /v1/recruitment/offers/{id}/confirm", {
    summary: "Offer accepted — confirm the joining date",
    params: idParam,
    body: z.object({ joiningDate: z.coerce.date() }),
  })
  async postRecruitmentOffersConfirm({ actor, params, body }: Ctx<"POST /v1/recruitment/offers/{id}/confirm">) {
    await confirmJoiningDate(actor, params.id, body.joiningDate);
    return { message: "Offer accepted — joining date confirmed" };
  }

  @Endpoint("POST /v1/recruitment/offers/{id}/decline", {
    summary: "Offer declined — the lead is dropped",
    params: idParam,
    body: z.object({ note }),
  })
  async postRecruitmentOffersDecline({ actor, params, body }: Ctx<"POST /v1/recruitment/offers/{id}/decline">) {
    await declineOffer(actor, params.id, body.note || undefined);
    return { message: "Offer declined — lead dropped" };
  }

  @Endpoint("POST /v1/recruitment/offers/{id}/join", {
    summary: "Candidate joined — schedules the retention checkpoints",
    params: idParam,
    body: z.object({ joinedAt: z.coerce.date() }),
  })
  async postRecruitmentOffersJoin({ actor, params, body }: Ctx<"POST /v1/recruitment/offers/{id}/join">) {
    await recordJoining(actor, params.id, body.joinedAt);
    return { message: "Joined — day-7 and day-30 retention checks scheduled" };
  }

  @Endpoint("POST /v1/recruitment/joinings/{id}/formalities", {
    summary: "Mark joining formalities complete",
    params: idParam,
  })
  async postRecruitmentJoiningsFormalities({ actor, params }: Ctx<"POST /v1/recruitment/joinings/{id}/formalities">) {
    await completeFormalities(actor, params.id);
    return { message: "Joining formalities marked complete" };
  }

  @Endpoint("POST /v1/recruitment/joinings/{id}/retention", {
    summary: "Record the day-7 or day-30 retention check",
    params: idParam,
    body: z.object({ day: z.number().nullable().optional(), retained: optStr, reason: note }),
  })
  async postRecruitmentJoiningsRetention({ actor, params, body }: Ctx<"POST /v1/recruitment/joinings/{id}/retention">) {
    const { day, retained } = body;
    if (day !== 7 && day !== 30) throw new ValidationError("Unknown checkpoint");
    if (retained !== "yes" && retained !== "no") throw new ValidationError("Choose retained or left");
    const reason = body.reason || undefined;
    if (retained === "no" && !reason) throw new ValidationError("Give a reason for leaving");
    await recordRetentionCheck(actor, params.id, day, retained === "yes", reason);
    return { message: retained === "no" ? "Recorded — lead dropped (left before 30 days)" : day === 30 ? "Retained 30 days — lead is Successful" : "Day-7 retention recorded" };
  }
}

@Module({ controllers: [VacanciesController] })
export class VacanciesModule {}
