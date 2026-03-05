## Setting up
1. Install Node.js 22+ and Docker.
2. Install workspace dependencies: `npm install`.
3. Review environment variables (defaults are zero-config): `ENV.md` and `.env.example`.
4. Generate contract artifacts (OpenAPI + typed client): `npm run gen:client`.
5. Start API + web + db with Compose: `docker compose up --build`.
6. For local non-container dev, run `npm run -w @devbox/api dev` and `npm run -w @devbox/web dev` (API uses Docker Engine via `dockerode` over `docker.sock`).

## User flows
1. Create a box from the API (`POST /v1/boxes`), web form, or CLI: `npm run -w @devbox/cli start -- create -n my-box`.
2. Watch status updates through SSE at `GET /v1/events` (web uses this after hydration).
3. Stop a box via API (`POST /v1/boxes/:boxId/stop`) or CLI: `... stop <boxId|name>`.
4. Remove a box via API (`DELETE /v1/boxes/:boxId`) or CLI: `... rm <boxId|name>`.
5. Stream logs through API SSE (`GET /v1/boxes/:boxId/logs?follow=true`) or CLI: `... logs -f <boxId|name>`.
