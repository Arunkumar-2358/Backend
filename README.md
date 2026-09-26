# Recruit CRM — API

Backend service for **Nextenti Recruit CRM**: the 9-stage healthcare recruitment life cycle (raw data dump → 30 days retained in the job), CV register and talent pool, outreach, sourcing, interviews and joining, scorecards, red flags / CAPA and weekly / monthly KPIs.

It is consumed by [`Frontend`](../Frontend) (the Next.js UI) and by machine integrations (NT platform, telephony, schedulers). Product spec: [docs/PLAN.md](docs/PLAN.md). Architecture decisions: [0001 — split web and API](docs/adr/0001-split-web-and-api.md), [0002 — adopt the PRD's ADR-1 platform](docs/adr/0002-adopt-prd-adr1-platform.md).

```
 Browser ──► Frontend (Next.js) ──access JWT──► Backend (NestJS on Fastify) ──► PostgreSQL (source of truth,
                    │  /api/v1/* proxied        │   guards · throttler · filters      scheduled_jobs outbox)
                    │  refresh in middleware    ├──► S3 / MinIO (CVs, videos, imports) ◄── ClamAV scan
                    └───────────────────────────┤──► Redis (rate limits)
      NT platform / Exotel / cron ─────────────►│   /v1/webhooks · /v1/telephony · /v1/cron
                                   worker (same image) ◄──► Redis / BullMQ ◄── dispatcher reads the outbox
```

## Stack

Node 22 · TypeScript · NestJS 11 (Fastify adapter) · Prisma 6 / PostgreSQL 16 · Redis 7 + BullMQ · S3 / MinIO · ClamAV · zod · Sentry · Prometheus · Vitest · tsup · Docker

## Quick start

```bash
npm install
cp .env.example .env               # set DATABASE_URL, SESSION_SECRET, PII_ENCRYPTION_KEY
docker compose up -d db redis      # or local Postgres; Redis is optional in dev (worker falls back to polling)
# optional, to mirror production storage + scanning: docker compose up -d minio bucket clamav
npm run db:deploy                  # apply migrations
npm run db:seed                    # teams, users, rules, templates, demo data (SEED_DEMO=0 skips demo data)
npm run dev                        # http://localhost:4000  ·  API docs at http://localhost:4000/docs
npm run dev:worker                 # second terminal: reminders, check-ins, retention checks, KPI freezing
```

Full backend stack in containers, configured like production (Redis, MinIO, ClamAV): `docker compose up --build`.

**Dev logins** (seeded): `<firstname>@nextenti.ai` / `Nextenti@123` — e.g. `admin`, `greeshma` (data analyst), `sumitha` (TA coordinator), `sarala` (Team 1 leader), `jennifer` (TA lead), `bhavani` (tele-caller), `dixha` (Team 2 leader), `srividya` (sourcer), `sanjay` (Team 3 leader), `harsha` (recruiter).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `dev:worker` | API / worker with reload (reads `.env`) |
| `npm run build` → `start` / `start:worker` | Production bundle in `dist/` |
| `npm test` | Vitest against a real Postgres test DB (service + HTTP tests) |
| `npm run lint` · `typecheck` | ESLint · `tsc --noEmit` |
| `npm run openapi` · `openapi:check` | Regenerate / verify `openapi.json` |
| `npm run db:migrate` · `db:deploy` · `db:seed` · `db:reset` | Prisma migrations and seed |
| `npm run migrate:zoho -- export.csv [--dry-run]` | Zoho import through the validation pipeline (safe to re-run) |
| `scripts/backup.sh` | `pg_dump`, keeps 14 days |

## Project layout

```
contracts/              public API surface, copied into the web app (see contracts/README.md)
  models.ts             generated from prisma/schema.prisma — do not edit
  routes/<domain>.ts    endpoint map: "METHOD /v1/path/{param}" → { params, query, body, response }
  shared/               dependency-free domain helpers used by both sides (RBAC predicates, stage graph, fields, dates…)
src/
  app.ts · app.module.ts buildApp(): NestJS on our Fastify instance, body parsers, global guards/filter
  server.ts · worker.ts process entry points (instrument.ts loads Sentry first)
  config/env.ts         zod-validated environment — refuses to start on bad or unsafe production config
  platform/             endpoint.ts (@Endpoint / @RawEndpoint, contract-typed), guards (auth, throttle),
                        errors (envelope + Sentry), auth (session check), openapi, metrics, redis
  lib/                  db, clock (injectable), PII crypto, audit, settings, RBAC lead scope
  kpi/                  metric registry, engine, snapshots + auto red flags, Excel export
  modules/<domain>/     service.ts (business logic) · queries.ts (read models) · <domain>.controller.ts (Nest)
    lifecycle/          rules.ts — ALL stage gate rules — and transition.ts (transitionLead)
    auth/               login, refresh-token sessions (rotation + reuse detection), logout
    jobs/               outbox (queue.ts), executor (runner.ts), BullMQ dispatcher/processor (bullmq.ts)
    storage/            local / S3 drivers, content sniffing, ClamAV
    candidates/ outreach/ scrutiny/ vacancies/ interviews/ eval/ redflags/ import/ messaging/ …
prisma/                 schema, migrations, seed
tests/                  service-level suites + tests/http (auth, RBAC, endpoints via app.inject)
```

## API conventions

- Versioned under `/v1`. JSON in and out; dates are ISO-8601 UTC strings.
- **Auth:** `Authorization: Bearer <access JWT>` or the `nt_session` cookie. `POST /v1/auth/login` returns a 15-minute access token and a single-use refresh token; `POST /v1/auth/refresh` rotates both (reuse of an old refresh token revokes the session). `POST /v1/auth/logout` / `logout-all` end sessions. Roles are reloaded and the session is checked on every request, so deactivation, password changes and logout take effect immediately.
- **Rate limits:** 600 req/min per IP globally; login 10/min per IP + email; shared across replicas via Redis.
- **Errors** always use one envelope: `{ "error": { "code", "message", "failures?", "requestId" } }` — `UNAUTHORIZED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 · `CONFLICT` 409 · `VALIDATION` / `GATE` 422 · `RATE_LIMITED` 429 · `INTERNAL` 500.
- Every response carries `x-request-id` (accepted from the caller if present) for log correlation.
- Interactive docs: `/docs` (disabled in production); machine-readable: `openapi.json`.

## Integrations

| Integration | Endpoint | Auth |
|---|---|---|
| NT platform enrolment | `POST /v1/webhooks/nt-enrolment` | `x-nt-signature` = hex HMAC-SHA256 of the raw body with `NT_WEBHOOK_SECRET` |
| Telephony missed calls (Exotel-style) | `POST` or `GET /v1/telephony/missed-call?token=…` | `TELEPHONY_WEBHOOK_TOKEN` |
| Scheduler (serverless alternative to the worker) | `POST /v1/cron/run-jobs` | `x-cron-secret` or `Bearer` `CRON_SECRET` |
| WhatsApp / SMS | `MESSAGING_PROVIDER=live` + `WHATSAPP_*` / `MSG91_*` | provider credentials |
| Error monitoring | `ERROR_WEBHOOK_URL` receives 5xx errors (Slack-compatible `text`) | — |

The legacy URLs `/api/webhooks/*`, `/api/telephony/*` and `/api/cron/*` on the web origin are proxied here, so existing provider configuration keeps working.

## Business rules that matter

- **`transitionLead(actor, leadId, toStage, payload)` is the only way a stage changes.** It enforces the stage graph, the performer rule and the gate, writes `lead_stage_history` (with an owner snapshot for KPI credit) and `audit_log`, and fires side effects in the same transaction.
- **Every automated or PII-touching action is audited** (`audit_log`), including PII views and exports.
- **Contact details are encrypted at rest** (AES-256-GCM) with HMAC blind indexes for dedupe.
- **KPIs are computed from events**; snapshots freeze at period end and raise automatic red flags against `kpi_targets`.
- Interpretation decisions: [docs/DECISIONS.md](docs/DECISIONS.md).

## Production notes

- One image runs both the API (`node dist/server.js`) and the worker (`node dist/worker.js`); run migrations as a release step (`npx prisma migrate deploy`). Migrations are additive and safe to run before the new image rolls out.
- In production the process refuses to start without `REDIS_URL`, `STORAGE_DRIVER=s3` + `S3_BUCKET`, or with a placeholder `SESSION_SECRET`. The API is stateless and scales horizontally.
- Scheduled automation: `scheduled_jobs` is a transactional outbox; the worker dispatches due rows to BullMQ and claims each row before running it, so the `/v1/cron/run-jobs` fallback can stay enabled. Losing Redis delays jobs, never loses them.
- Health: `GET /health` (liveness), `GET /health/ready` (database + Redis). Worker: `WORKER_HEALTH_PORT` → `/healthz`, `/metrics`.
- Metrics: `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN` (Prometheus). Errors: `SENTRY_DSN` (PII scrubbed).
- The first deploy of this version signs everyone out once (older tokens have no session id).
- Logs are structured JSON (pino); `authorization`, `cookie` and passwords are redacted.
