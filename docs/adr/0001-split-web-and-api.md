# ADR 0001 — Split the monolith into `Frontend` (web) and `Backend` (API)

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Recruit CRM started as one Next.js 15 App Router application. Pages were async server components that queried Prisma directly (35 of 39 pages, ~134 inline queries); writes were 65 server actions; the session cookie was set by a server action. This was fast to build but:

- the only way to reach business logic was through the UI process — integrations (telephony, NT platform), the job worker and future clients (mobile, partner portal, reporting) had no stable interface;
- permission checks were split between pages, actions and services, so the security boundary was hard to audit;
- frontend and backend could not be deployed, scaled or owned independently.

## Decision

Two repositories with a typed HTTP contract between them.

| | `Backend` | `Frontend` |
|---|---|---|
| Runtime | Node 22, Fastify 5 | Node 22, Next.js 15 (standalone) |
| Owns | PostgreSQL (Prisma), domain services, RBAC enforcement, PII encryption + audit, jobs worker, webhooks, file storage, exports | UI, routing, session cookie, server actions as thin command adapters |
| Contract | `contracts/` — generated model types, route map (`ApiRoutes`), dependency-free shared domain helpers | synced copy in `src/contracts/` |

Key choices:

1. **Contract-first TypeScript instead of generated OpenAPI clients.** Every JSON endpoint is registered via `route(app, "METHOD /path", …)`, which type-checks its zod input schemas and its return value against `ApiRoutes`. The web client is typed from the same map. OpenAPI is still generated (`openapi.json`, `/docs`) for humans and non-TS consumers.
2. **The API is the security boundary.** Every page/action permission check is enforced in the API; the web keeps role checks only to shape the UI. Roles are reloaded from the database on every request, not trusted from the token.
3. **Same-origin proxy.** The browser only talks to the web origin; `/api/v1/*` is rewritten to the API. The session JWT stays in an httpOnly, SameSite=Lax cookie, there is no CORS surface, and legacy webhook URLs (`/api/webhooks/*`, `/api/telephony/*`, `/api/cron/*`) keep working.
4. **Server actions stay.** Forms keep `useActionState`/`<ActionForm>`; actions parse `FormData` and call the API, and `ApiError`s map back to the same inline messages. This kept the UI diff small and the UX identical.
5. **Dates** travel as ISO-8601 strings and are revived to `Date` in the web client, so view code is unchanged.

## Consequences

- An extra network hop per page render (web server → API, same region/VPC). Pages fetch one view-model endpoint each to keep this to a single round trip.
- Contract changes are API changes: bump `contracts/`, then `npm run contracts:sync` in the web repo in the same change set. CI in the web repo fails on drift.
- Two deploy units (plus the worker). `docker-compose.yml` in the API repo runs the backend stack locally.
- Local disk file storage must move to object storage (S3-compatible) before running more than one API instance — tracked separately.
