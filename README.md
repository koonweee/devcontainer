# Devbox Platform

> **Warning**: Web app authentication is not implemented yet. Implement OAuth login for the full web app before production deployment.

Monorepo for a Docker-image-based dev box platform with strict privilege boundaries. Every dev box runs as a single Docker workspace container with Tailscale SSH enabled inside that runtime, which keeps SSH access simple and makes it straightforward to expose development services such as web apps over the Tailnet.

## Workspace components

- `packages/orchestrator`: framework-agnostic orchestration library (jobs, box lifecycle, Docker allowlist).
- `apps/api`: Fastify API adapter around orchestrator calls and SSE streams.
- `apps/web`: SvelteKit web client using generated API client + SSE after hydration.
- `apps/cli`: API-only CLI client for create/list/start/stop/remove/logs flows.
- `packages/api-client`: generated typed client from OpenAPI, shared by web and CLI.
- `docker/runtime/Dockerfile`: workspace image used for created dev boxes.

## Canonical docs

- Setup and user workflows: [USAGE.md](USAGE.md)
- Architecture boundaries and component responsibilities: [ARCHITECTURE.md](ARCHITECTURE.md)
- Environment variables (required/optional/defaults): [ENV.md](ENV.md)
- Contributor guardrails and documentation rules: [AGENTS.md](AGENTS.md)
