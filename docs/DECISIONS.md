# Decisions and interpretations

These are the places where PLAN.md left something open and the build had to choose. Each one should be confirmed with the business. Items marked ⚠ touch the data model or the stage rules, and PLAN.md asks for explicit sign-off on those.

## Life cycle (§3)
- ⚠ **Import and Mapping.** An imported row that passes dedupe and the 10-digit check becomes a lead in **Mapping**. If it already has a category, a job title and a geography, it moves on to **Validated** automatically through `transitionLead`, so the history records the step. If it lacks any of those, it stays in Mapping and the data analyst completes it.
- ⚠ **Who signs off each gate.** The Enrolled → Qualified gate needs the **Team 2 leader**. Every other forward gate can be passed by any member of the team that owns the stage, as long as they own the lead, lead the team, or have an open task on it (for example, a tele-caller who was allocated the lead). The data analyst is the sign-off for Mapping.
- ⚠ **Not-interested exits.** A lead can leave as NOT_INTERESTED from Validated, Enrolled, Qualified or Active. DROPPED is available from Sourced, Selected and Joined and needs a reason code. Terminal stages cannot be reopened. Reopening would be a rule change and needs sign-off.
- **Rejection and no-show at interview.** Either one sends the lead to DROPPED, unless the lead has another live submission to a different vacancy.
- **Availability check-ins.** A newly Qualified lead gets an availability check-in task immediately, and then another every 60 days while it stays Qualified. A cold lead that later confirms availability counts as a cold → warm conversion.
- **Day-30 retention.** A passed day-30 check moves the lead to **Successful** and adds one filled opening to the vacancy. When every opening is filled, the vacancy closes.

## Data (§4)
- ⚠ **NT vs non-NT.** Non-NT means the job-portal sources: NAUKRI, LINKEDIN, INDEED and a new OTHER_PORTAL value. Every other source is part of Nextenti's own funnel and counts as NT. `is_nt_source` is derived from the source.
- ⚠ **Fields added to the schema** so that KPIs can be calculated from events:
  - `lead_stage_history.prev_owner_user_id` and `owner_user_id`: ownership snapshots, used to credit the right agent.
  - `candidates.scrutinized_at` and `scrutinized_by_id`
  - `candidates.created_by_id`
  - `availability_checks.was_cold`
  - `vacancies.sourcer_id` and `was_pending`
  - `missed_calls`: a new table for the Team 1b inbox
  - `scheduled_jobs`: a new table that stores reminders durably
- **Candidate codes** are generated from a sequence, in the form NTC000001. Vacancy codes follow the pattern VAC00001.
- **Contact details** (mobile, alternate mobile, email) are stored AES-GCM encrypted, and each has an HMAC blind index. Search by the last 4 digits uses `mobile_last4`.

## KPIs (§6)
- **"Opening vacancies"** means vacancies that were open at the start of the period. The Team 3 rates (interviews, offers, joinings and closures) divide by *vacancies in hand*, which is opening + newly added, so that a week that starts with nothing open does not divide by zero.
- **"Pending"** vacancies are OPEN vacancies from an earlier day (IST) that are still below the CV target. A nightly job marks them. "Closed pending" counts pending vacancies whose sourcing completed during the period.
- **"Enrolled screened by TL" and "approved after scrutiny"** (Team 1a) are cohort counts. They look at the leads a TA lead enrolled in the period and count how many Team 2 has since scrutinised or qualified.
- **"Mismatched qualified leads"** (Team 4) means leads qualified in the period whose CV a recruiter later rejected.
- **Working days** exclude Sundays and entries in the holiday calendar. Saturday counts as a working day, and the same calendar applies to the 1-working-day red-flag SLA.
- **Excel layout.** The export follows the layout implied by PLAN §6: one tab per team, KPIs as rows, agents as columns, then team total and target, followed by the "Red flags noticed" and "Action taken" rows. It should be compared against the real "Weekly and monthly Analysis" sheet, and cell positions adjusted in `src/kpi/export.ts` if needed.
