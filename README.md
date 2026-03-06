# Devbox Platform

Docker-image-based dev box platform with strict privilege boundaries.

Each dev box runs as a **single managed workspace container** that includes Tailscale and supports Tailnet SSH access directly in that container.

## Workspace components

- `packages/orchestrator` — framework-agnostic orchestration library (jobs, lifecycle, Docker allowlist).
- `apps/api` — Fastify API wrapper around orchestrator operations and SSE streams.
- `apps/web` — SvelteKit frontend using generated API client + client-side SSE updates after hydration.
- `apps/cli` — API-only CLI client for setup and box lifecycle workflows.
- `packages/api-client` — generated typed OpenAPI client shared by web and CLI.
- `docker/runtime/Dockerfile` — runtime image used for managed dev box containers.

## Canonical docs

- Setup and user workflows: [USAGE.md](USAGE.md)
- Architecture boundaries and responsibilities: [ARCHITECTURE.md](ARCHITECTURE.md)
- Environment variable reference: [ENV.md](ENV.md)
- Contributor/development guardrails: [AGENTS.md](AGENTS.md)

## Notes

- Web app authentication is not implemented yet; add OAuth login before production use.
