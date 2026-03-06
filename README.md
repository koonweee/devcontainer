# Devbox Platform

> Self-hosted dev boxes for running multiple AI-agent workspaces with Tailscale access and a tighter Docker privilege boundary.

This repo is a Docker-image-based dev box platform for individual developers who want to spin up multiple remote workspaces for AI agents without hand-rolling Docker automation. You define the dev environment in the runtime Dockerfile, then each box boots as one ready-to-use workspace container managed through a web app and CLI backed by a shared typed API.

You can SSH into each box over Tailscale, reach box-local services over the tailnet, and keep separate agent tasks isolated in their own workspaces without normal host-port exposure. `docker.sock` stays confined to the API, while the web app and CLI remain unprivileged clients instead of getting direct Docker access.

> **Warning**: Web app authentication is not implemented yet. Implement OAuth login for the full web app before production deployment.

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
