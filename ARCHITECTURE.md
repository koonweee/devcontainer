# Architecture

This repo is an npm-workspaces monorepo with strict privilege boundaries between API, web, and CLI.

```mermaid
flowchart LR
  CLI["CLI (apps/cli)"] --> API["Fastify API (apps/api)"]
  WEB["SvelteKit Web (apps/web)"] --> API
  API --> ORCH["Orchestrator Library (packages/orchestrator)"]
  IMG["Runtime Image (docker/runtime/Dockerfile)"] --> ORCH
  ORCH --> DOCKER["Docker Engine (docker.sock)"]
  API --> SQLITE["SQLite (job + box state)"]
  WEB -. shared contract .-> CLIENT["OpenAPI Client (packages/api-client)"]
  CLI -. shared contract .-> CLIENT
  CLIENT --> API
```

## Components
- Orchestrator library: [`packages/orchestrator/src`] owns box lifecycle (`create/start/stop/remove`), job orchestration, and Docker allowlisted operations.
- API service: [`apps/api/src/app.ts`] is a thin Fastify wrapper around orchestrator calls and SSE endpoints; OpenAPI is exposed at `/openapi.json`.
- Runtime status monitor: orchestrator subscribes to Docker container events via [`packages/orchestrator/src/dockerode-runtime.ts`] and publishes reconciled `box.updated` and `box.removed` events for live UI state (including external container deletions and managed external starts that recover errored boxes).
- Box log streaming: API exposes box-scoped SSE logs (`/v1/boxes/:boxId/logs`) and forwards `follow/since/tail` to orchestrator runtime log streams with managed-container checks.
- Shared API client: [`packages/api-client/src`] is generated from OpenAPI and used by both web and CLI.
- Web app: [`apps/web/src/routes/+page.server.ts`] handles initial SSR fetch/gating, and [`apps/web/src/lib/devbox-store.ts`] applies SSE updates directly after hydration plus tabbed per-box log viewers rendered with [`apps/web/src/lib/LogTerminal.svelte`] (`xterm`, one mounted terminal for the active tab).
- CLI app: [`apps/cli/src/index.ts`] is an API client only and does not access Docker or DB directly; log streaming uses API endpoint options (`follow/since/tail`).
- Runtime image: [`docker/runtime/Dockerfile`] defines the image used for created dev boxes.

## Trust boundaries
- API is the only privileged component and is the only service that can mount `docker.sock`.
- Orchestrator operations must be allowlisted and constrained to managed resources.
- Web and CLI are unprivileged API consumers and never access Docker or DB directly.
- API and web are deployed as separate containers/services.

## Runtime network model
- Each created box is assigned a dedicated Docker network (`devbox-net-<boxId>`) by the orchestrator and attached to that network as its container `NetworkMode`.
- Boxes are therefore isolated from each other by default at the Docker-network level (no shared box network).
- Caveat: these per-box networks use Docker bridge defaults (not `internal` and no egress policy), so outbound connectivity is still available from each box subject to host/Docker routing and firewall policy.

## Key references
- Compose deployment wiring: [`docker-compose.yml`]
- Environment contract: [`ENV.md`]
- Setup and user workflows: [`USAGE.md`]
