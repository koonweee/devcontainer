# Devbox Platform

Monorepo for a Docker-image-based dev box platform with strict privilege boundaries.

## Components

- `packages/orchestrator`: framework-agnostic orchestration library (jobs, lifecycle, Docker allowlist).
- `apps/api`: Fastify API adapter around orchestrator calls and SSE streams.
- `apps/web`: SvelteKit web client using generated API client + SSE after hydration.
- `apps/cli`: API-only CLI client for create/list/stop/remove/logs flows.
- `packages/api-client`: generated typed client from OpenAPI, shared by web and CLI.
- `docker/runtime/Dockerfile`: runtime image used for created dev boxes.

## Quick start

1. Install dependencies: `npm install`
2. Build runtime image: `npm run build:runtime-image`
3. Generate client contracts: `npm run gen:client`
4. Start API + web: `docker compose up --build`

For setup details and user flows, see `USAGE.md`.  
For architecture boundaries and component relationships, see `ARCHITECTURE.md`.  
For environment variables, defaults, and recommendations, see `ENV.md`.
