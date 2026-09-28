// Endpoints for the vacancies domain (vacancies, matching, recruitment board). See contracts/README.md.
import type {
  Candidate,
  ClientOrg,
  Interview,
  Joining,
  LeadStageHistory,
  Offer,
  Submission,
  User,
  Vacancy,
} from "../models";
import type { MessageResult } from "../http";

export type SourcingStats = {
  submissions: number;
  nt: number;
  nonNt: number;
  target: number;
  targetMet: boolean;
  tatMinutes: number | null;
  postToCalibrationMinutes: number | null;
  calibrationToTargetMinutes: number | null;
};

export type VacancyListRow = Vacancy & {
  clientOrg: ClientOrg;
  recruiter: Pick<User, "name"> | null;
  sourcer: Pick<User, "name"> | null;
  stats: SourcingStats;
};

export interface VacancyList {
  total: number;
  page: number;
  pageSize: number;
  vacancies: VacancyListRow[];
  orgs: Pick<ClientOrg, "id" | "name">[];
  cvTargetPerVacancy: number;
  cvMinTeam3bc: number;
}

export type MatchCandidate = Pick<
  Candidate,
  "id" | "name" | "candidateCode" | "primarySpecialty" | "experienceYears" | "expectedCtcLakhs" | "noticePeriodDays" | "preferredLocations" | "isNtSource" | "consentRecordStoreShare"
>;
export interface VacancyMatch {
  candidate: MatchCandidate;
  score: number;
  breakdown: { specialty: number; experience: number; location: number; ctc: number; notice: number };
}

export type VacancySubmissionRow = Submission & {
  candidate: Pick<Candidate, "id" | "name" | "candidateCode" | "stage">;
  submittedBy: Pick<User, "name"> | null;
  /** The latest interview only. */
  interviews: Interview[];
};

export interface VacancyDetail {
  vacancy: Vacancy & {
    clientOrg: ClientOrg;
    recruiter: Pick<User, "name"> | null;
    sourcer: Pick<User, "name"> | null;
    /** Team 1a TA lead given the posting to source portal CVs. */
    taLead: Pick<User, "name"> | null;
    submissions: VacancySubmissionRow[];
  };
  stats: SourcingStats;
  cvMinTeam3bc: number;
  /** Ranked Active leads not yet submitted (empty when the vacancy is closed). */
  matches: VacancyMatch[];
}

export type BoardSubmission = Submission & {
  vacancy: Vacancy & { clientOrg: Pick<ClientOrg, "name"> };
  interviews: Interview[];
  offers: (Offer & { joining: Joining | null })[];
};
export type BoardLead = Pick<Candidate, "id" | "name" | "candidateCode" | "stage" | "stageChangedAt"> & { submissions: BoardSubmission[] };
export type BoardOutcome = LeadStageHistory & {
  candidate: Pick<Candidate, "id" | "name" | "candidateCode" | "dropReason">;
  byUser: Pick<User, "name"> | null;
};

export interface RecruitmentBoard {
  /** Team 3 leader / admin: every Team 3a/3b/3c vacancy; otherwise vacancies assigned to the caller. */
  isLeader: boolean;
  leads: BoardLead[];
  reminderHours: number[];
  outcomes: BoardOutcome[];
}

type Id = { params: { id: string } };

export interface VacancyRoutes {
  "GET /v1/vacancies": {
    /** Unknown status / category / team values are ignored, as the page always did. */
    query?: { q?: string; status?: string; category?: string; team?: string; org?: string; mine?: boolean; page?: number };
    response: VacancyList;
  };
  "POST /v1/vacancies": {
    body: {
      clientOrgId?: string;
      title?: string;
      category?: string;
      specialty?: string;
      location?: string;
      minExperienceYears?: number;
      ctcMinLakhs?: number;
      ctcMaxLakhs?: number;
      maxNoticeDays?: number;
      openings?: number;
      postedAt?: Date;
      description?: string;
      mandatoryAttributes?: string;
    };
    response: MessageResult & { id: string };
  };
  "GET /v1/vacancies/client-orgs": { response: ClientOrg[] };
  "POST /v1/vacancies/client-orgs": { body: { name?: string; type?: string; city?: string }; response: MessageResult & { id: string } };
  "GET /v1/vacancies/{id}": Id & { response: VacancyDetail };
  "POST /v1/vacancies/{id}/calibrate": Id & { response: MessageResult };
  "POST /v1/vacancies/{id}/status": Id & { body: { status?: string }; response: MessageResult };
  "POST /v1/vacancies/{id}/submissions": Id & { body: { candidates: { id: string; matchScore?: number | null }[] }; response: MessageResult };
  "POST /v1/vacancies/{id}/invites": Id & { body: { candidateIds: string[]; channel?: string }; response: MessageResult };
  "POST /v1/vacancies/submissions/{id}/decision": Id & { body: { decision?: string }; response: MessageResult };

  "GET /v1/recruitment": { response: RecruitmentBoard };
  "POST /v1/recruitment/interviews": { body: { submissionId?: string; scheduledAt: Date; mode?: string; notes?: string }; response: MessageResult };
  "POST /v1/recruitment/interviews/{id}/reschedule": Id & { body: { scheduledAt: Date }; response: MessageResult };
  "POST /v1/recruitment/interviews/{id}/outcome": Id & { body: { outcome?: string; notes?: string }; response: MessageResult };
  "POST /v1/recruitment/offers": { body: { submissionId?: string; ctcLakhs?: number | null; joiningDate?: Date | null }; response: MessageResult };
  "POST /v1/recruitment/offers/{id}/confirm": Id & { body: { joiningDate: Date }; response: MessageResult };
  "POST /v1/recruitment/offers/{id}/decline": Id & { body: { note?: string }; response: MessageResult };
  "POST /v1/recruitment/offers/{id}/join": Id & { body: { joinedAt: Date }; response: MessageResult };
  "POST /v1/recruitment/joinings/{id}/formalities": Id & { response: MessageResult };
  "POST /v1/recruitment/joinings/{id}/retention": Id & { body: { day?: number | null; retained?: string; reason?: string }; response: MessageResult };
}
