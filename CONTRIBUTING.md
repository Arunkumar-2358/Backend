# Contributing

## Workflow
1. Branch from `main`: `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`.
2. Keep PRs focused; include tests for behaviour changes.
3. CI must be green (lint, typecheck, OpenAPI drift, tests against Postgres, build, Docker build).
4. Squash-merge with a message that explains *why*.

## Changing the API contract
Endpoints are declared in `contracts/routes/<domain>.ts` and implemented with `route(app, "METHOD /path", …)` in `src/modules/<domain>/routes.ts`.

1. Edit the contract and the handler — TypeScript will tell you if they disagree.
2. `npm run openapi` and commit `openapi.json`.
3. In the Frontend repo: `npm run contracts:sync`, update callers, open a paired PR.
4. Prefer additive changes; removing or renaming a field requires the web PR to merge first.

## Conventions
- Domain logic lives in services (`src/modules/<domain>/service.ts`); read models in `queries.ts`; HTTP glue in `routes.ts`.
- Permission checks belong in the API, never only in the UI.
- Throw `ValidationError` / `GateError` / `ForbiddenError` / `notFound()` — the error plugin turns them into the standard envelope.
- Every automated or PII-touching action writes to `audit_log`.
- `contracts/` must stay dependency-free (ESLint enforces it).

## Database
`npm run db:migrate` creates a migration from `prisma/schema.prisma` and regenerates `contracts/models.ts` — commit both.
