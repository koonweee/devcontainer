# Devbox Platform

Monorepo for a Docker-image-based dev box platform with strict privilege boundaries.

## Workspace components

- `packages/orchestrator`: framework-agnostic orchestration library (jobs, lifecycle, Docker allowlist).
- `apps/api`: Fastify API adapter around orchestrator calls and SSE streams.
- `apps/web`: SvelteKit web client using generated API client + SSE after hydration.
- `apps/cli`: API-only CLI client for create/list/start/stop/remove/logs flows.
- `packages/api-client`: generated typed client from OpenAPI, shared by web and CLI.
- `docker/runtime/Dockerfile`: runtime image used for created dev boxes.

## Canonical docs

- Setup and user workflows: [USAGE.md](USAGE.md)
- Architecture boundaries and component responsibilities: [ARCHITECTURE.md](ARCHITECTURE.md)
- Environment variables (required/optional/defaults): [ENV.md](ENV.md)
- Contributor guardrails and documentation rules: [AGENTS.md](AGENTS.md)
