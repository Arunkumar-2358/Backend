# Runbook — production deploy (ADR-1 platform release)

Owner: on-call engineer · Applies to: `Backend` (API + worker) and `Frontend` (web), released together.

## 0. Before the day (T-1)

- [ ] Both PRs green in CI, reviewed (CodeRabbit + one human), merged to `main`.
- [ ] Staging deployed from `main` and smoke-tested with the steps in §4 for at least a few hours
      (let the worker run through at least one dispatcher cycle and one recurring job).
- [ ] Provisioned (managed services preferred, `ap-south-1` for DPDP data residency):
  - PostgreSQL 16 with automated backups + point-in-time recovery.
  - Redis 7 with **`maxmemory-policy noeviction`** (BullMQ requirement) and persistence (AOF), private network only.
  - S3 bucket: private, Block Public Access ON, SSE enabled, versioning ON, lifecycle rule for `imports/` (e.g. 90 days).
    The API's IAM role needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `arn:aws:s3:::<bucket>/*` only.
  - ClamAV (`clamav/clamav:stable`) reachable on 3310 from the API, private network only. Allow ~3 min on first boot
    for signature download; the API refuses uploads (503) while it is unreachable — by design.
- [ ] Secrets generated fresh for production (never reuse dev/staging values):
      `SESSION_SECRET` (`openssl rand -hex 32`, **same value on API and web**), `PII_ENCRYPTION_KEY`
      (**must be the existing production key if data already exists — changing it makes stored contact details unreadable**),
      `METRICS_TOKEN`, `CRON_SECRET`, `NT_WEBHOOK_SECRET`, `TELEPHONY_WEBHOOK_TOKEN`, VAPID keys.
- [ ] Announce: "Everyone will be asked to sign in again once after the release."

## 1. Environment

API and worker (same image, same env):

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | managed Postgres (use `?connection_limit=` sized to replicas × pool) |
| `REDIS_URL` | `rediss://…` (TLS) |
| `STORAGE_DRIVER` / `S3_BUCKET` / `S3_REGION` | `s3` / bucket / `ap-south-1` (credentials from the task IAM role) |
| `CLAMAV_HOST` / `CLAMAV_PORT` | scanner host / `3310` |
| `CORS_ORIGINS` | the web origin only |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT=production`, `RELEASE_SHA` | error tracking |
| `METRICS_TOKEN`, worker `WORKER_HEALTH_PORT=4001` | Prometheus scraping |
| `MESSAGING_PROVIDER` | `mock` until providers are contracted (PRD open decision), then `live` + provider keys |

The API **refuses to start** in production without Redis, S3 or with a placeholder session secret — a failed boot
here is a config error, not a code bug.

Web: `API_URL` (internal API address), `SESSION_SECRET` (same as API), optional `NEXT_PUBLIC_SENTRY_DSN`.

## 2. Order of operations

1. **Back up** the database (on-demand snapshot) and note the snapshot id here: `__________`.
2. **Migrate** (release step, one-off task with the new image): `npx prisma migrate deploy`.
   This release's migration is additive only (new enum values, a nullable column, a new table): safe while the old
   version is still serving.
3. **Deploy the worker** (1 replica is enough; 2 is safe — dispatch uses `FOR UPDATE SKIP LOCKED` and jobs are
   claimed before running). Check its log line `"mode":"bullmq"`.
4. **Deploy the API** (≥ 2 replicas behind the load balancer; health check `GET /health`, readiness `GET /health/ready`).
5. **Deploy the web app.**
6. Keep the scheduler fallback: an external cron hitting `POST /v1/cron/run-jobs` every 5 min with `x-cron-secret`
   is safe alongside the worker and covers a worker outage.

## 3. Rollback

- Web or API misbehaving → redeploy the previous image tags. The migration is additive, so the old code runs on the
  new schema; no data fix is needed. (Users will need to sign in again: old images use 12-hour tokens.)
- Worker misbehaving → scale it to 0 and rely on the cron fallback while investigating; no jobs are lost
  (they wait in `scheduled_jobs`).
- Data corruption (unlikely for this release) → restore the snapshot from step 1.

## 4. Smoke test (≈10 minutes, after each environment deploy)

1. `curl -s https://<api>/health/ready` → `{"status":"ok","db":"up","redis":"up"}`.
2. Sign in as a test user in the web app → dashboard renders; browser devtools show `nt_session` and `nt_refresh`
   as **HttpOnly; Secure**.
3. Stay idle > 15 minutes, click around → still signed in (silent refresh worked).
4. Profile → "Sign out of all other devices" → another browser's session is signed out on its next click.
5. Upload a real PDF resume to a test lead → succeeds; download it → opens. Upload a renamed `.exe` as `.pdf` →
   rejected with a friendly message. (Optional EICAR test string in a `.txt`-named file via imports → "malware detected".)
6. Import a small CSV → report shows accepted / rejected rows.
7. Schedule an interview ~2h 5m ahead for a test lead → within a few minutes the admin jobs page shows the
   T-2h reminder as PENDING; it runs at the right time (or check `nt_jobs_processed_total`).
8. `curl -H "Authorization: Bearer $METRICS_TOKEN" https://<api>/metrics | grep nt_http_request_duration` → data.
9. Sentry: trigger nothing; confirm the release appears once real traffic flows, and that events contain no request
   bodies, cookies or query strings.

## 5. Alerts to configure (day one)

| Signal | Condition | Meaning |
|---|---|---|
| `nt_queue_jobs{state="outbox_due"}` (worker `/metrics`) | > 0 for 10 min | dispatcher or Redis down — reminders delayed |
| `nt_queue_jobs{state="outbox_failed"}` | increases | a handler is failing 5× — check `scheduled_jobs.lastError` |
| worker `/healthz` | non-200 for 2 min | worker loop stalled |
| API `/health/ready` | non-200 on > 1 replica | DB or Redis unreachable |
| `nt_http_request_duration_seconds` p95 | > 0.5 s for 10 min | PRD performance target breached |
| 5xx rate | > 1 % for 5 min | regressions — check Sentry |
| ClamAV | 503s on uploads | scanner down — uploads refused (fail closed) |

## 6. Known limits of this release

- Messaging and telephony providers are in test mode until contracted (PRD §25 open decision).
- Very large imports run synchronously (25 MB cap); async import processing is the next platform item.
- Scorecard PDF export uses the browser's print-to-PDF.
