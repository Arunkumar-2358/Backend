# Nextenti Recruit CRM — Build Plan for Claude Code

> **How to use:** Save this file as `PLAN.md` at the root of an empty repo and tell Claude Code:
> *"Read PLAN.md. Build the system phase by phase. Finish each phase's acceptance criteria, including tests, before starting the next. Ask me before you change the data model or the stage rules."*

---

## 1. Context

Nextenti (NT) is a healthcare talent platform (doctors, nurses, pharmacy, allied health, HNI and executive search). Today the recruitment operation runs on Excel and Zoho. This CRM replaces that with one system that covers:

1. **The lead life cycle**, from a raw data dump to a candidate who has stayed 30 days in the job (9 stages, each with a gate that must be passed).
2. **A CV register / talent pool** (34 fields per candidate).
3. **Interview evaluation**: a weighted scorecard that compares up to 3 candidates.
4. **Red flags and CAPA** (Corrective and Preventive Action) for SOP and KPI deviations.
5. **Weekly and monthly KPI analysis** for each team and each agent.

Terms: **NT** = Nextenti platform. **Non-NT** = outside job portals (Naukri, LinkedIn, Indeed and others). **TA** = Talent Acquisition. **TAT** = turnaround time.

---

## 2. Teams, roles and permissions

| Team | Who (from sheet) | Owns stages / work | Role in app |
|---|---|---|---|
| Team 4 – Data analyst | Greeshma | **Mapping**: import, dedupe, validate raw data. Also data-quality KPIs | `data_analyst` |
| Team 1a – TA Leads | Sarala (TL); Jennifer (Nursing), Poojitha (Pharmacy), Mounika & Shivani (HNI/Doctor), Shravya (Others) | **Validated → Enrolled**: outreach and conversion. Also pull leads from non-NT portals | `ta_lead`, `team1_leader` |
| Team 1b – Communication centre | Bhavani, Punitha, Devi (tele-callers) | First-time verified calls and missed-call recalls | `telecaller` |
| Team 2 – Talent Sourcers | Dixha (TL); Sri Vidya (Nursing/others), Amos (Pharmacy/Allied), Bhavya (HNI/Doctor) | **Enrolled → Qualified → Active → Sourced**: scrutiny, availability check-ins, CV matching to vacancies | `sourcer`, `team2_leader` |
| Team 3a/3b/3c – Recruitment | Sanjay (TL); Harsha, Sampath | **Sourced → Selected → Joined → Successful**. 3a = general, 3b = existing client orgs, 3c = free-trial orgs | `recruiter`, `team3_leader` |
| Team 4 – TA coordinator | Sumitha | Raises red flags, suggests CAPA, tracks closure SLA | `ta_coordinator` |
| Admin | — | Users, teams, templates, SOP config, weights | `admin` |

**Permission rules:**
- Agents see and edit the leads they own and the stages their team owns.
- Team leaders see their whole team, can reassign leads and must sign off on their gates (for example, "Status: complete and verified by team leader").
- The TA coordinator and admin can read everything. Only the coordinator and admin can create or close red flags.
- Every stage change, field edit and reassignment is written to an **audit log**.

---

## 3. Lead life cycle (core state machine)

```
MAPPING → VALIDATED → ENROLLED → QUALIFIED → ACTIVE → SOURCED → SELECTED → JOINED → SUCCESSFUL
                │                     │ (cold)    ▲
                │                     └───────────┘ re-check every 60 days
                └── exits: NOT_INTERESTED, UNREACHABLE (after N attempts), DUPLICATE, INVALID
Later exits: DROPPED (interview no-show / rejected / offer declined / left before 30 days), each with a reason code
```

| # | Stage | Owner | Gate to advance (enforced by the system) | Next |
|---|---|---|---|---|
| 1 | **Mapping** | Team 4 (Greeshma) | (a) duplicate mobile numbers removed; (b) mobile has exactly 10 digits after normalisation (strip +91, spaces, dashes); (c) job title / category and geography assigned | Validated |
| 2 | **Validated** | Team 1 leader | At least one contact attempt by WhatsApp, email, SMS or call is logged with an outcome. Outcomes: `UNANSWERED`, `NOT_INTERESTED`, `INTERESTED_LINK_SENT_NOT_REGISTERED` (Bb), `BUSY_RECALL_REQUESTED` (Bc), `ENROLLED`. Bb and Bc (and Unanswered) automatically create follow-up tasks until the outcome is Enrolled or a terminal outcome | Enrolled |
| 3 | **Enrolled** | Team 2 leader | All mandatory SOP fields complete (profile completeness = 100% of mandatory fields). If anything is missing, a "call to collect details" task is created. Team leader verifies | Qualified |
| 4 | **Qualified** | Team 2 leader | Fit to map to a job profile. The system schedules an availability check-in **every 2 months**. If the candidate confirms availability, the stage moves to Active; if not, the lead is flagged **cold** and stays Qualified | Active |
| 5 | **Active** | Team 2 leader | Willing to join. When a matching vacancy opens, the lead is contacted, applies, and the CV is forwarded to the recruiter | Sourced |
| 6 | **Sourced** | Team 3 leader | Interview date and time fixed and communicated. Automatic reminders are sent until the interview happens. Interview attended and candidate selected (the scorecard can be used here) | Selected |
| 7 | **Selected** | Team 3 leader | Offer letter sent, then follow-ups until the joining date is confirmed and the candidate joins | Joined |
| 8 | **Joined** | Team 3 leader | Joining formalities complete. Retention checkpoints at **day 7** and **day 30** | Successful |
| 9 | **Successful** | — | Retained 30 days (terminal success, counts as a vacancy closure) | — |

**Implementation:** use a single `transitionLead(leadId, toStage, payload)` service that checks the gate rules, writes a `LeadStageHistory` row and fires side-effects (tasks, reminders). Keep the rules in one module so they are easy to change. The UI must never set a stage directly.

---

## 4. Data model (Postgres)

**Candidate / Lead** (maps the CV Register's 34 columns):
- Identity: `candidate_code` (e.g. "Aaa" today, so make it auto-generated), `name`, `mobile` (unique, 10-digit), `alt_mobile`, `email`
- Qualification: `basic_qualification`, `additional_qualifications[]`, `registration_number`, `registration_authority`, `registration_year`
- Profile: `main_category` (Doctor / Nurse / Pharmacy / Allied / Admin / Other), `profession_functional_head`, `primary_specialty`, `secondary_skills[]`, `experience_years`, `current_org`, `current_designation`, `current_location`, `preferred_locations[]` (ordered by priority)
- Commercials: `current_ctc_lakhs`, `expected_ctc_lakhs`, `notice_period_days`, `earliest_availability_date`, `availability_status`, `shift_preference`, `employment_preference` (full-time / part-time / locum / contract)
- Source: `source` enum (Conventional marketing, NT, Naukri, LinkedIn, Indeed, Referral, Digital marketing, Other), `is_nt_source` (derived)
- Files: `resume_file`, `intro_video` (1-minute), stored in object storage
- Compliance: `consent_record_store_share` (boolean plus timestamp; required before sharing a CV, per India's DPDP Act)
- Ops: `owner_user_id`, `stage`, `is_cold`, `duplicate_check_status`, `profile_completeness_pct` (computed), `tl_remarks`, `verification_status` (`INCOMPLETE` / `COMPLETE_VERIFIED`), `verified_by`, `last_updated`

**Other tables:**
- `users`, `teams` (1a, 1b, 2, 3a, 3b, 3c, 4), `user_team_roles`
- `import_batches` (file, counts: total / duplicates / invalid numbers / accepted) and `import_rows` (raw row plus rejection reason)
- `lead_stage_history` (from, to, by, at, note)
- `contact_attempts` (lead, channel: CALL / WHATSAPP / SMS / EMAIL, direction: outbound / inbound-missed / recall, outcome, notes, next_followup_at, by)
- `tasks` (type: follow-up / recall / collect-details / availability-check / interview-reminder / offer-follow-up / retention-check; due_at; assignee; status)
- `client_orgs` (type: `EXISTING` / `FREE_TRIAL`, which routes the vacancy to Team 3b or 3c)
- `vacancies` (client_org, title, category, specialty, location, CTC range, openings, posted_at, calibrated_at, status: OPEN / PENDING / CLOSED, `added_before_2pm` derived, sourcing_completed_at)
- `submissions` (vacancy, lead, source NT or non-NT, submitted_by, submitted_at, recruiter decision)
- `interviews` (submission, scheduled_at, mode, status, reminders_sent, attended)
- `offers` (submission, sent_at, accepted_at, joining_date), `joinings` (joined_at, retained_7d_at, retained_30d_at, left_at, reason)
- **Evaluation:** `eval_templates` (criteria and sub-criteria with weight %, **weights must add up to exactly 100**), `evaluations` (vacancy, template, up to 3 candidates as "alternatives"), `eval_scores` (criterion, candidate, score 1–5, net = weight × score)
  - Default criteria from the sheet: Domain knowledge; Emotional intelligence; Crisis management; Strategy; Communication & interpersonal skills; Leadership qualities (Personality type, Delegation, Accountability & responsibility); HRM (Employee engagement, Motivation)
- **Red flags:** `red_flags` with the sheet's columns: date, team, description, agent, KPI deviated, target/standard, actual, raised_on, CAPA suggested (by TA coordinator), expected outcome, due date, completion date, action owner, corrective action implemented, achieved outcome, status OPEN / CLOSED. Add `closed_within_1_working_day` (derived, uses a holiday calendar)
- `kpi_snapshots` (team, user, period_type WEEK / MONTH, period_start, metric_key, value), frozen at period end
- `message_templates` (WhatsApp / SMS / email, including the enrolment-link template), `audit_log`

---

## 5. Modules and features

### M1. Data import and mapping (Team 4)
- Upload Excel/CSV and map columns to fields (save the mapping for reuse; include a preset for the CV Register template and a Zoho export).
- Validation pipeline: normalise phone numbers, reject any that are not 10 digits, dedupe within the file **and** against the existing database (by mobile, then email), group by job title and geography.
- Batch report with downloadable rejects. Accepted rows become leads in **Validated** stage, assigned to Team 1 by category (Nursing → Jennifer, Pharmacy → Poojitha, and so on; the rules are configurable).

### M2. Outreach workspace (Teams 1a and 1b)
- A "My queue" of leads sorted by due follow-up, with one-click logging of the channel and outcome.
- Buttons to send the enrolment link (WhatsApp / SMS / email) from templates. Keep the provider behind an adapter interface and ship a console/mock adapter first.
- Automatic follow-up tasks for the outcomes Unanswered, Bb and Bc. Attempts are capped (configurable, default 5), after which the lead is marked Unreachable.
- Missed-call inbox for Team 1b: log a missed incoming call, schedule a recall, then track answered → link sent → enrolled.
- "Enrolled" can be set manually, or through a webhook/API from the NT platform when the candidate registers. Build the webhook endpoint.
- Proactive leads from non-NT portals are entered with `source = non-NT` so they count toward the separate KPIs.

### M3. Enrolment scrutiny and qualification (Team 2)
- A profile checklist against the SOP's mandatory fields (configurable list), with a live completeness %.
- Queue of incomplete profiles with a "collect details" call task. Team leader verifies with a remark, then the lead moves to Qualified.
- Scheduler for the 60-day availability check-in. Cold/warm flag. Report on cold → warm conversions.

### M4. Vacancies and sourcing (Teams 2 and 3)
- Vacancy intake (with client org type) records posted time, calibration time and whether it was added before 2 pm.
- **Matching:** filter or rank Active leads by category, specialty, experience, location preference, expected CTC and notice period. Show a match score.
- Target of **5 matching CVs per vacancy** (the sheet also tracks "at least 2" for Teams 3b/3c). Track NT versus non-NT sources.
- TAT = posting → calibration → submission of the 5th CV, in minutes.
- Bulk "invite to apply" to matched active leads.

### M5. Interviews, offers, joining and retention (Team 3)
- Interview scheduling with automatic reminders (for example T-24h and T-2h) to the candidate.
- Scorecard evaluation (M6) attached to the interview.
- Offer tracking and follow-up tasks until joining.
- Retention checks on day 7 and day 30. Day 30 moves the lead to **Successful** and closes the vacancy opening.

### M6. Evaluation scorecard
- An admin-editable template. Validation blocks saving unless the weights total 100%.
- Score up to 3 candidates side by side. Net score = weight% × score; total out of 5 (or scaled to 100). Ranked result, printable/PDF.

### M7. Red flags and CAPA (Team 4 coordinator)
- Raise manually or **automatically** when a KPI falls below target (targets are configurable per metric per team).
- Workflow: Open → CAPA suggested → action owner implements → coordinator verifies → Closed. Due-date alerts.
- Linked into the weekly sheet's "Red flags noticed" and "Action taken" columns for each team.

### M8. KPI dashboards and reports
Weekly (Monday–Sunday) and monthly views for each agent, each team and overall. Export to Excel in the same layout as the current "Weekly and monthly Analysis" sheet. Every metric is computed from event data; there is **no manual entry**, except "working days" (taken from attendance input).

---

## 6. KPI definitions (compute from events)

**Team 1a (per TA lead):** working days; validated leads assigned; enrolled from validated; non-NT portal leads downloaded; enrolled from non-NT; total enrolled; enrolled screened by TL; % screened by TL; approved after scrutiny; % approved; % enrolled from validated; % enrolled from non-NT; calls attempted; unanswered/pending calls.

**Team 1b (per tele-caller):**
- Verified first-time calls: allocated, attended, answered, links sent, enrolled.
- Missed calls: missed incoming, recalls attempted, answered, links sent, enrolled.
- Ratios for each funnel: attempted/allocated, answered/attempted, links/answered, enrolled/links.

**Team 2:** enrolled leads scrutinised; qualified leads; cold → warm conversions; open vacancies in hand; vacancies added before 2 pm; vacancies with 5 CVs from NT; vacancies with 5 CVs from non-NT; closed pending vacancies; average TAT (minutes); % scrutiny; % qualified out of enrolled; % vacancies sourced from NT; % sourced from non-NT; average sourced CVs per vacancy.

**Team 3a / 3b:** opening vacancies; newly added; pending; (3b: vacancies with ≥2 matching CVs); interviews conducted; offers given; joinings; 7-day retention; 30-day retention; rates of interviews, offers, joinings and closures over opening vacancies.

**Team 3c (free-trial orgs):** opening, new, pending, vacancies with ≥2 CVs, % of opening vacancies with CVs given.

**Team 4 – Data analyst:** incomplete enrolled leads; mismatched qualified leads; plus a cross-team roll-up of the funnel.

**Team 4 – Coordinator:** red flags raised per team (1, 2, 3); closed within 1 working day; closed beyond 1 working day.

> Put each metric in one registry file (`kpi/definitions.ts`) with its key, label, team, formula (SQL or query builder) and target. Write a unit test for each formula against seeded fixtures.

---

## 7. Recommended tech stack (swap if your team prefers otherwise)
- **Next.js (App Router) + TypeScript**, **Tailwind + shadcn/ui**, **TanStack Table** for the heavy grid views
- **PostgreSQL + Prisma**; **pg-boss** (or BullMQ + Redis) for scheduled reminders and follow-ups
- **Auth.js** (email/OTP or Google Workspace SSO) with role-based access middleware
- **S3-compatible storage** for resumes and intro videos
- Integration adapters: WhatsApp Business Cloud API, SMS gateway (e.g. MSG91), email (SMTP/SES), telephony/IVR for missed calls (e.g. Exotel), NT platform webhook. All ship as mocks first.
- **ExcelJS** for import/export; **Recharts** for dashboards
- **Vitest** + **Playwright**; Docker Compose for local development; seed script with the real team names from the sheet

---

## 8. Build phases and acceptance criteria

**Phase 0 – Foundation**
- Repo, Docker Compose, Prisma schema (full model from §4), auth, RBAC, seeded users/teams, audit log, app shell with role-aware navigation.
- ✅ Every role can log in and sees only its menu; migrations run cleanly; CI runs lint and tests.

**Phase 1 – Talent pool and import (M1)**
- Candidate CRUD with all 34 fields, profile completeness, file upload, consent capture; import wizard with dedupe and 10-digit validation; batch reports.
- ✅ Importing a file with duplicates and 9/11-digit numbers rejects them with reasons; a re-import doesn't create duplicates.

**Phase 2 – Life-cycle engine and outreach (§3, M2)**
- `transitionLead` with gate rules, stage history, Kanban and list views per stage, contact logging, follow-up task engine, templates, mock messaging, missed-call inbox, NT enrolment webhook.
- ✅ A stage cannot be skipped or advanced without meeting its gate; Bb/Bc outcomes create tasks; tests cover every transition.

**Phase 3 – Scrutiny, qualification, availability (M3)**
- ✅ Incomplete profiles cannot be qualified; the 60-day check-in fires (tested with a fake clock); cold/warm toggling works.

**Phase 4 – Vacancies, matching, submissions (M4)**
- ✅ Matching returns ranked Active leads; the 5-CV target and TAT are computed; routing to 3a/3b/3c by org type works.

**Phase 5 – Interviews → Successful (M5) and scorecard (M6)**
- ✅ Reminders are scheduled; the day 7 and day 30 checks move the lead correctly; scorecard weights are enforced at 100%; 3-candidate comparison renders and exports.

**Phase 6 – Red flags / CAPA (M7) and KPI engine (M8)**
- ✅ Every metric in §6 is implemented with a test; weekly and monthly dashboards per agent and team; Excel export matches the current sheet layout; auto red flags when targets are missed; 1-working-day SLA is computed with a holiday calendar.

**Phase 7 – Integrations and hardening**
- Real WhatsApp/SMS/email/telephony adapters, Zoho data migration script, performance with 100k+ candidates (indexes on mobile, stage, owner, category), backups, error monitoring.

---

## 9. Non-functional requirements
- Indian locale: ₹ in lakhs, IST time zone, DD-MM-YYYY display, +91 phone handling.
- PII: encryption at rest for contact details, consent required before a CV leaves the system, access logs, a data-deletion request flow (DPDP Act).
- Fast grid performance on large lists (server-side pagination and filtering), responsive for tele-callers using the app on phones.
- Every automated action (reminder, red flag, stage change) is traceable in the audit log.

---

## 10. Assumptions and open questions (confirm with business before or during Phase 2)
1. What are the **mandatory SOP fields** for "Enrolled → Qualified"? *(Assumed: name, mobile, email, qualification, registration, category, specialty, experience, locations, CTCs, notice period, resume, consent.)*
2. What is the **maximum number of contact attempts** before a lead is marked Unreachable? *(Assumed 5.)*
3. What are the **KPI targets** for each metric, used to trigger automatic red flags?
4. Is the NT platform able to send an **enrolment webhook**, or will enrolment be marked manually?
5. Which WhatsApp, SMS and telephony providers are already contracted?
6. Is Zoho (Recruit/CRM) the current system of record that needs a **data migration**?
7. Should the evaluation scorecard be used for **candidates at client interviews**, for **internal employee grading**, or both? (The sheet title says "Employee grading template".)
8. The difference between Team 3a and 3b/3c is assumed to be client type (general vs existing vs free-trial). Please confirm.
