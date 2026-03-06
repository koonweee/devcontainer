# Devbox Platform

> **Warning**: Web app authentication is not implemented yet. Implement OAuth login for the full web app before production deployment.

Monorepo for a Docker-image-based dev box platform with strict privilege boundaries. Every dev box runs as a grouped workspace plus Tailscale sidecar, with inbound traffic restricted to Tailnet only.

## Workspace components

- `packages/orchestrator`: framework-agnostic orchestration library (jobs, grouped box lifecycle, Docker allowlist).
- `apps/api`: Fastify API adapter around orchestrator calls and SSE streams.
- `apps/web`: SvelteKit web client using generated API client + SSE after hydration.
- `apps/cli`: API-only CLI client for create/list/start/stop/remove/logs flows.
- `packages/api-client`: generated typed client from OpenAPI, shared by web and CLI.
- `docker/runtime/Dockerfile`: workspace image used for created dev boxes.
- `docker/tailscale-sidecar/Dockerfile`: privileged Tailscale sidecar image paired with each workspace.

## Canonical docs

- Setup and user workflows: [USAGE.md](USAGE.md)
- Architecture boundaries and component responsibilities: [ARCHITECTURE.md](ARCHITECTURE.md)
- Environment variables (required/optional/defaults): [ENV.md](ENV.md)
- Contributor guardrails and documentation rules: [AGENTS.md](AGENTS.md)
