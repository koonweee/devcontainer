---
status: implemented
owner: codex
created: 2026-03-05
updated: 2026-03-05
---

# Simple implementation plan: Docker-image-based dev boxes

## 1) Proposed repo layout
Use a small monorepo layout with clear boundaries:

- `packages/orchestrator` — framework-agnostic TypeScript orchestration library
- `apps/api` — Fastify API (thin adapter over orchestrator)
- `apps/web` — SvelteKit UI (API client only)
- `apps/cli` — Node CLI (API client only)
- `packages/api-client` — generated shared OpenAPI client used by web + CLI
- `packages/shared-types` (optional) — minimal cross-package utility types only if needed
- `docs/` optional for diagrams; keep root docs authoritative (`USAGE.md`, `ARCHITECTURE.md`)

## 2) Orchestrator library API surface
Define minimal public API in `packages/orchestrator`:

- `createBox(input): Promise<{ box: Box; job: Job }>`
- `listBoxes(filter?): Promise<Box[]>`
- `getBox(boxId): Promise<Box | null>`
- `stopBox(boxId): Promise<Job>`
- `removeBox(boxId): Promise<Job>`
- `streamBoxLogs(boxId, options): AsyncIterable<LogEvent>`
- `listJobs(filter?): Promise<Job[]>`
- `getJob(jobId): Promise<Job | null>`

Supporting abstractions:
- `DockerRuntime` interface (real + mocked impl)
- `BoxRepository` / `JobRepository`
- `JobRunner` (in-process worker loop)

Fastify should call these methods directly and map errors to HTTP responses.

## 3) Core data model + minimal DB schema
Use a simple SQL DB (SQLite for local dev; Postgres optional later).

### Box
Fields:
- `id` (uuid)
- `name` (unique, user-facing)
- `image`
- `status` (`creating|running|stopping|stopped|removing|error`)
- `container_id` (nullable)
- `network_name`
- `volume_name`
- `tailnet_url` (nullable)
- `created_at`, `updated_at`, `deleted_at` (nullable)

### Job
Fields:
- `id` (uuid)
- `type` (`create|stop|remove|sync|cleanup`)
- `status` (`queued|running|succeeded|failed|cancelled`)
- `box_id` (nullable for global jobs)
- `progress` (0-100)
- `message`
- `error` (nullable)
- `created_at`, `started_at`, `finished_at`

Keep schema intentionally small; add columns only when proven necessary.

## 4) Docker conventions
Use strict conventions for managed resources:

- Container name pattern: `devbox-<boxId>`
- Network pattern: `devbox-net-<boxId>`
- Volume pattern: `devbox-vol-<boxId>`
- Required labels on all managed resources:
  - `com.devbox.managed=true`
  - `com.devbox.box_id=<boxId>`
  - `com.devbox.owner=orchestrator`

Rules:
- API may operate only on resources with `com.devbox.managed=true`.
- On stop/remove, clean up container/network/volume in deterministic order.
- Add startup reconciliation job to detect drift (e.g., missing container for DB row).

## 5) Fastify API + SSE + log streaming
Minimal endpoints:

- `POST /v1/boxes` → enqueue create job
- `GET /v1/boxes` → list boxes
- `GET /v1/boxes/:boxId` → box details
- `POST /v1/boxes/:boxId/stop` → enqueue stop job
- `DELETE /v1/boxes/:boxId` → enqueue remove job
- `GET /v1/boxes/:boxId/logs` → stream logs (SSE or chunked text)
- `GET /v1/jobs` / `GET /v1/jobs/:jobId`
- `GET /v1/events` → SSE stream for job/box updates

SSE event types:
- `job.updated`
- `box.updated`
- `box.logs`
- `heartbeat`

Log streaming approach:
- API reads Docker log stream and forwards line events.
- For `logs -f`, prefer SSE event stream with cursor/timestamp param support.

## 6) OpenAPI generation
Use Fastify swagger plugins:
- expose OpenAPI JSON at `/openapi.json`
- keep schema registration near routes
- validate all request/response payloads with shared schemas

Treat `/openapi.json` as the contract source for client generation.

## 7) OpenAPI client generation (shared for web + CLI)
Choose simplest path: **`openapi-typescript` + small fetch wrapper**.

Plan:
- `packages/api-client` contains:
  - generated TS types from `/openapi.json`
  - tiny typed request helpers (`get/post/delete`, SSE connect helper)
- add script: `pnpm gen:client` (or repo package-manager equivalent)
- CI runs:
  - generate client
  - fail if generated output differs from committed files

This guarantees both web and CLI use one typed contract.

## 8) SvelteKit SSR considerations
- Use SSR only for:
  - initial page shell
  - auth gating/session checks
  - optional first data fetch
- After hydration, subscribe to SSE for live jobs/box status.
- Do not SSR live state.
- Keep Docker/orchestrator logic out of web container entirely.
- Keep pages thin; put live state logic in Svelte stores using generated API client.

## 9) CLI plan (API client only)
CLI app (`apps/cli`) behavior:

- Config via `DEVBOX_API_URL` (default `http://localhost:3000`)
- Commands:
  - `create`
  - `ls`
  - `stop <boxId|name>`
  - `rm <boxId|name>`
  - `logs -f <boxId|name>`
- Logs/events consume API stream (SSE or fetch streaming endpoint)
- No direct Docker access and no direct DB access.

## 10) Local dev workflow
Use Docker Compose for runtime services:
- `api` container (has privileged `docker.sock` mount)
- `web` container (no docker.sock)
- `db` container

CLI runs locally on host and points to API URL.

Keep local setup one-command where possible (`compose up --build`).

## 11) Basic tests + CI for TDD
Start with lightweight coverage:

- Unit tests (orchestrator):
  - input validation
  - state transitions for create/stop/remove
  - Docker client mocked
- API tests (Fastify `inject`):
  - happy/error paths
  - schema validation behavior
- Optional integration smoke test:
  - create/list/remove tiny test container in CI only if environment supports Docker
  - otherwise run locally and document limitation
- Contract checks:
  - OpenAPI generation
  - client generation
  - typecheck using generated client

Suggested CI order:
1. lint
2. typecheck
3. unit + route tests
4. build
5. client generation check (`gen:client` clean diff)

Local fast iteration:
- test watch mode
- incremental typecheck command

## 12) Required documentation steps
For every implementation PR from this plan:

1. Update root `USAGE.md`:
   - keep exactly 2 sections: `Setting up`, `User flows`
   - keep concise, action-oriented instructions
2. Update root `ARCHITECTURE.md`:
   - brief component structure and boundaries
   - include/update simple diagram(s) and links to key packages/routes
3. In PR checklist, include:
   - “Reviewed whether further `USAGE.md` updates are needed”
   - “Reviewed whether further `ARCHITECTURE.md` updates are needed”

## 13) Completion step for this plan
When implementation is finished:
- update this plan front matter `status` to `implemented`
- update front matter `updated:` date


## Functional changes after implementation
- Users can create, list, stop, remove, and monitor dev boxes via API, web UI, and CLI without direct Docker access from web/CLI.
- Long-running operations report progress/status as jobs and stream updates through SSE.
- Managed Docker resources are isolated and cleaned up predictably using labels and naming conventions.
- Web and CLI behavior stays contract-aligned through one generated OpenAPI client package.

## High-ROI tests to prioritize
- Orchestrator unit: create/stop/remove state transitions with mocked Docker runtime (highest regression risk).
- Orchestrator unit: input validation + allowlist enforcement for names/images/options (security boundary).
- API route tests: enqueue and status endpoints (`POST /v1/boxes`, `POST /v1/boxes/:id/stop`, `DELETE /v1/boxes/:id`, `GET /v1/jobs/:id`) using Fastify `inject`.
- API route tests: SSE endpoint emits `job.updated`/`box.updated` and heartbeat shape validation.
- Contract check: regenerate OpenAPI client and fail CI on diff + typecheck web/cli against generated client.
