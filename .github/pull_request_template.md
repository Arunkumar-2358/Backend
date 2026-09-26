## What & why

## How it was tested
- [ ] `npm run lint && npm run typecheck && npm test`
- [ ] New/changed endpoints covered in `tests/http/` (including RBAC denial cases)

## Contract impact
- [ ] No change to `contracts/`
- [ ] Contract changed → `npm run openapi` committed, paired Frontend PR: <!-- link -->

## Data / security
- [ ] Migration included, additive / zero-downtime (or expand–contract plan described), or N/A
- [ ] New routes are authenticated (or `auth: "public"` with signature/token verification)
- [ ] PII stays encrypted, is never logged, and every PII view/export is audited
- [ ] Jobs scheduled inside the business transaction (`db`/`tx` passed)

## Rollout
- [ ] New env vars documented in `.env.example` and the deploy runbook, or N/A
- [ ] Safe to roll back to the previous image without a data fix, or rollback plan described
