## Setting up
### For development
1. Install Node.js 22+ and Docker.
2. Install dependencies: `npm install`.
3. Review env defaults: `ENV.md` and `.env.example`.
4. Generate contracts: `npm run gen:client`.
5. Start stack: `docker compose up --build`.
6. Optional local app-only runs: `npm run -w @devbox/api dev` and `npm run -w @devbox/web dev`.
7. Verify changes: `npm run typecheck && npm run test`.
8. Match CI locally before opening a PR: `npm run lint && npm run test && npm run build && npm run check:client`.

### For deployment
1. Configure runtime values in `ENV.md` (usually `DEVBOX_PUBLIC_API_URL`, `DEVBOX_INTERNAL_API_URL`, `DEVBOX_API_URL`, `DEVBOX_DB_PATH`).
2. Build and start services with your target orchestrator or Compose profile.
3. Ensure API container can access `/var/run/docker.sock`; do not grant that mount to web/CLI.
4. Run post-deploy checks: `npm run gen:client`, `npm run typecheck`, and API health checks.

## User flows
1. Create a box from the API (`POST /v1/boxes`), web form, or CLI: `npm run -w @devbox/cli start -- create -n my-box`.
2. Web flow from `http://localhost:4173` calls the API at `http://localhost:3000` with API CORS support enabled.
3. Watch status updates through SSE at `GET /v1/events` (web uses this after hydration).
4. Stop a box via API (`POST /v1/boxes/:boxId/stop`) or CLI: `... stop <boxId|name>`.
5. Remove a box via API (`DELETE /v1/boxes/:boxId`) or CLI: `... rm <boxId|name>`.
6. Reuse removed box names; name uniqueness is enforced only for active (not soft-deleted) boxes.
7. Stream logs through API SSE (`GET /v1/boxes/:boxId/logs?follow=true`) or CLI: `... logs -f <boxId|name>`.
8. Box list/detail reads (`GET /v1/boxes`, `GET /v1/boxes/:boxId`) reconcile persisted status with current Docker container state.
9. In web UI, `Stop` is enabled only for `running` boxes; API stop remains idempotent when Docker reports an already-stopped container.
