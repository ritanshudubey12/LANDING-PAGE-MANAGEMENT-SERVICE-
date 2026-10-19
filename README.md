# Landing Page Management API

Node.js + TypeScript microservice (Express, PostgreSQL via `pg`, no ORM) that manages landing-page **metadata and
lifecycle**: create, list, get, rename / change slug, duplicate, soft-delete, and explicit publish / unpublish requests.
Built from *Landing Page Management API – Final Technical Report v2.0*.

## Quick start

```bash
cp .env.example .env               # then replace the placeholders with real secrets (.env is git-ignored)
docker compose up -d --build        # postgres (5441) + api (4027); migrations run on start
curl localhost:4027/health          # {"success":true,"data":{"status":"ok"},...}
npm run postman:run                 # 13 requests, all expected 200 OK
npm test                            # 85 unit / integration / security tests (needs postgres on 5441)
```

Local dev without Docker for the API: `cp .env.example .env`, set `DATABASE_URL`, then `npm run migrate && npm run dev`.

## Design decisions

| Topic | Decision |
|---|---|
| Auth topology | **B – private service behind a trusted BFF/gateway.** `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` (constant-time compare). Context headers are only read after this validates. End-user JWT validation is the gateway's job. |
| Context | `X-Tenant-Id`, `X-Organization-Id`, `X-User-Id` required; `X-Software-Id` optional; all strict BIGINT strings. `X-Request-Id` accepted if well-formed, else generated. `X-Permissions` (comma list) carries the gateway-asserted permissions. Built once in middleware, frozen; never read from the body (strict schemas reject such fields with 422). |
| Isolation | Every query is scoped by `tenant_id + organization_id` (+ `website_id` for lists). Out-of-scope pages return **404** (concealed). |
| IDs | BIGINT in PostgreSQL, **strings** in JSON. Range-validated (≤ 9223372036854775807). |
| Success status | Every successful call returns **HTTP 200** (including create/duplicate/delete). |
| Slug policy | lowercase `a-z0-9` + single hyphens, ≤180. Unique per website among ACTIVE non-deleted pages (case-insensitive, DB unique index → 409). Archived/deleted pages release the slug. |
| DELETE | Soft-delete tombstone + audit; a live page is unpublished first (503 if Publishing doesn't confirm). |
| Concurrency | `ETag: "page-v{n}"` / `If-Match` → 412 when stale. `Idempotency-Key` on create / duplicate / publish / unpublish (409 on key reuse with a different request). |
| Pagination | Keyset cursor, sort allowlist (`createdAt`, `updatedAt`, `name`), `limit` 1–100. |

## Endpoints

| Method | Path | Permission |
|---|---|---|
| POST | `/api/v1/websites/{websiteId}/landing-pages` | `landing-page:create` |
| GET | `/api/v1/websites/{websiteId}/landing-pages` | `landing-page:read` |
| GET | `/api/v1/landing-pages/{id}` | `landing-page:read` |
| PATCH | `/api/v1/landing-pages/{id}` | `landing-page:update` (partial: name and/or slug) |
| PUT | `/api/v1/landing-pages/{id}` | `landing-page:update` (full replace: name and slug both required) |
| POST | `/api/v1/landing-pages/{id}/duplicate` | `landing-page:duplicate` |
| DELETE | `/api/v1/landing-pages/{id}` | `landing-page:delete` |
| POST | `/api/v1/landing-pages/{id}/publish` | `landing-page:publish` |
| POST | `/api/v1/landing-pages/{id}/unpublish` | `landing-page:publish` |
| GET | `/health`, `/ready` | none |

Full contract: [openapi/landing-page-api.yaml](openapi/landing-page-api.yaml). Postman:
[postman/](postman/) (regenerate with `npm run postman:generate`; the generated environment file holds the real token and is git-ignored).

## ⚠️ Open blockers (report §16)

The Document/Draft-Version and Publishing **API contracts are not confirmed**, so no endpoint paths were invented.
They sit behind interfaces in [src/integrations/clients.ts](src/integrations/clients.ts):

* `INTEGRATIONS_MODE=stub` (default for local/test): in-process stand-ins (ids from DB sequences; publish
  returns `PUBLISHED`). **Blocked in `NODE_ENV=production`.**
* `INTEGRATIONS_MODE=http`: fails closed with `503 INTEGRATION_CONTRACT_NOT_CONFIGURED` and `/ready` reports not-ready.
  Implement `createHttpIntegrations` against the real contracts (plus contract tests) before going live.

Also still open: real service URLs/timeouts, whether websites are shareable across organizations, and the
website-ownership check (`WebsiteClient`, currently a no-op stub).

## Operations

* Structured JSON logs with secret redaction; request id on every log line and response.
* Audit rows in `audit_log`; failed cross-service cleanup is queued in `workflow_operations` and retried by the
  reconciler (`RECONCILE_INTERVAL_MS`).
* Migrations: `migrations/NNN_name.{up,down}.sql`; `npm run migrate` / `npm run migrate:down` (reverts the latest).
* Graceful shutdown on SIGTERM/SIGINT; bounded `pg` pool; in-memory per-IP rate limit (use a shared store across replicas).

## Not covered / honest limits

* Tests ran against the local Postgres container with stubbed integrations; nothing here proves behaviour against the
  real Document or Publishing services.
* No end-user JWT/JWKS validation (topology A) is implemented by design.
* No load, penetration, or CI pipeline has been run; add CI to run `npm run typecheck && npm test` and the Newman run.
