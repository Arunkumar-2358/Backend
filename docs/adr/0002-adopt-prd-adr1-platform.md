# ADR 0002 — Adopt the PRD's ADR-1 platform (NestJS, Redis/BullMQ, S3, refresh tokens)

- **Status:** Accepted
- **Date:** 2026-09-26
- **Supersedes:** the "Runtime: Fastify 5" row of [ADR 0001](0001-split-web-and-api.md); everything else in 0001 stands.

## Context

The Product Requirements Document (§18, §28 "ADR-1") fixes the production stack: Next.js + shadcn/ui, **NestJS**,
PostgreSQL/Prisma, **Redis + BullMQ**, a custom rules engine on Postgres + BullMQ, **S3-compatible storage with malware
scanning**, **JWT + refresh tokens with RBAC via guards**, Sentry + Prometheus, Docker on a managed platform.

The split API (ADR 0001) already had the right shape — domain services, a typed contract, a single security boundary —
but ran on plain Fastify, polled Postgres for scheduled jobs, stored files on local disk and issued 12-hour tokens.
The launch window is two days, so the migration had to be low-risk.

## Decision

### 1. NestJS owns transport; domain logic stays framework-free
- NestJS 11 runs on the **existing Fastify instance** (`@nestjs/platform-fastify`, one Fastify version via `overrides`),
  so helmet, cookie and multipart behaviour is unchanged and tests keep using `inject()`.
- Every domain is a Nest module with a controller. Controllers are thin: they call the same `service.ts` / `queries.ts`
  functions as before. **We did not convert services to injectable classes** — they are covered by 300+ tests, are
  pure functions over Prisma, and rewriting them two days before launch would add risk without adding value.
- `@Endpoint("METHOD /v1/path/{param}", { params, query, body })` (src/platform/endpoint.ts) validates input with
  zod and **type-checks the handler's return value against `contracts/ApiRoutes`**, preserving the contract-first
  guarantee from ADR 0001. `@RawEndpoint` covers downloads and provider webhooks.
- Cross-cutting concerns are Nest primitives: a global `ApiAuthGuard` (fail-closed: undeclared routes are denied),
  a Redis-backed `ThrottlerGuard`, and `ApiExceptionFilter` producing the unchanged error envelope.
- No reliance on `emitDecoratorMetadata` (esbuild/tsx/vitest cannot emit it): DI always uses explicit `@Inject(TOKEN)`.

### 2. Scheduled automation: Postgres outbox + BullMQ executor
`scheduled_jobs` stays the source of truth and is still written **inside the business transaction** (a reminder exists
iff the interview was committed). The worker's dispatcher moves due rows to BullMQ (`jobId = row id`, idempotent);
the processor claims the row (`PENDING|QUEUED → RUNNING`) before running, so the cron fallback and the worker can
never double-send. If Redis is lost, a reaper returns stale QUEUED/RUNNING rows to PENDING — **no job is lost**,
which addresses the ADR's "Redis becomes a single point of failure" consequence. Without `REDIS_URL` (dev/test)
the worker polls, as before.

### 3. Sessions: 15-minute access JWT + rotating refresh tokens
- Access token: HS256 JWT (`sub, name, roles, sid, typ`), 15 minutes, verifiable at the edge by the web middleware.
  The API still reloads roles from the database on every request and now also checks the session is live, so
  logout, deactivation and password changes take effect immediately, not at token expiry.
- Refresh token: opaque `<id>.<secret>`, only SHA-256(secret) stored, single use, rotated on every refresh,
  7-day idle / 30-day absolute lifetime. Reuse of a rotated token outside a 20-second grace window (concurrent tabs)
  revokes the whole session family and is audited as `REFRESH_REUSE`.
- Login is rate-limited per IP + email (an office behind one NAT is not locked out by a colleague's typos).

### 4. Files: S3/MinIO, content sniffing and ClamAV, fail closed
Every `storage.put` sniffs magic bytes against the extension and, when `CLAMAV_HOST` is set, streams the file to
clamd; if the scanner is unreachable the upload is refused (503), never silently accepted. Objects use SSE.

### 5. Observability
Sentry (API + web) with PII scrubbing (no bodies, cookies, auth headers, query strings); Prometheus `/metrics`
(token-gated) with HTTP latency by route pattern, job outcomes and queue depth; `/health` and `/health/ready`
(DB + Redis).

### 6. Production guard rails
The process refuses to start in production without `REDIS_URL`, `STORAGE_DRIVER=s3` + `S3_BUCKET`, or with a
placeholder `SESSION_SECRET`.

## Consequences
- **One-time sign-out at deploy:** tokens issued before this release have no `sid` and are rejected; users sign in
  once. Announce it with the release.
- Redis is now required in production and must be monitored (queue depth, failed jobs), but Redis loss degrades to
  delayed automation, not lost automation.
- Two more services to run (Redis, ClamAV); MinIO only when self-hosting S3.
- Domain services remain plain functions. If a future module needs request-scoped DI, introduce providers
  incrementally at that module rather than refactoring everything.

## Not done in this change (tracked)
- Asynchronous processing of very large imports (PRD §22 "Import async for large files") — imports remain
  synchronous with a 25 MB cap.
- Server-side PDF export of scorecards (Puppeteer / @react-pdf) — the web app prints to PDF today.
- SSO (explicitly Phase 4 in the PRD).
