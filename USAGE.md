## Setting up
### For development
1. Install Node.js 22+ and Docker.
2. Install dependencies: `npm install`.
3. Review env defaults: `ENV.md` and `.env.example`; set box-runtime envs in `docker/runtime/runtime.env`.
4. Build the runtime image from `docker/runtime/Dockerfile`: `npm run build:runtime-image`.
5. Generate contracts: `npm run gen:client`.
6. Start stack: `docker compose up --build`.
7. Compose runs two services (`api`, `web`); API persists state in SQLite via the `devbox-data` volume (`DEVBOX_DB_PATH=/data/devbox.sqlite` by default).
8. Optional local app-only runs: `npm run -w @devbox/api dev` and `npm run -w @devbox/web dev`.
9. Verify changes: `npm run typecheck && npm run test`.
10. Match CI locally before opening a PR: `npm run lint && npm run test && npm run build && npm run check:client`.

### For deployment
1. Build and publish your runtime box image from `docker/runtime/Dockerfile` (or equivalent CI build), then set `DEVBOX_RUNTIME_IMAGE` to that tag/digest.
2. Configure runtime values in `ENV.md` (usually `DEVBOX_RUNTIME_IMAGE`, `DEVBOX_PUBLIC_API_URL`, `DEVBOX_INTERNAL_API_URL`, `DEVBOX_API_URL`, `DEVBOX_DB_PATH`) and set box-runtime envs in `docker/runtime/runtime.env`.
3. Build and start services with your target orchestrator or Compose profile (`api` + `web`), and mount persistent storage for SQLite at `DEVBOX_DB_PATH`.
4. Ensure API container can access `/var/run/docker.sock`; do not grant that mount to web/CLI.
5. Run post-deploy checks: `npm run gen:client`, `npm run typecheck`, and API health checks.

## User flows
1. Create a box from the API (`POST /v1/boxes` with `name`, optional `command`/`env`), web form, or CLI: `npm run -w @devbox/cli start -- create -n my-box`.
2. Box image selection is locked down; all creates use the server-configured `DEVBOX_RUNTIME_IMAGE`.
3. Runtime env for created boxes is configured server-side in `docker/runtime/runtime.env`; every key/value in that file is injected into created boxes (for example `DEV_PASSWORD=password`).
4. If that image is missing on the Docker host, create jobs fail with an actionable runtime-image error.
5. Web flow from `http://localhost:4173` calls the API at `http://localhost:3000` with API CORS support enabled.
6. Watch status updates through SSE at `GET /v1/events` (web uses this after hydration).
7. Stop a box via API (`POST /v1/boxes/:boxId/stop`) or CLI: `... stop <boxId|name>`.
8. Remove a box via API (`DELETE /v1/boxes/:boxId`) or CLI: `... rm <boxId|name>`.
9. Reuse removed box names; name uniqueness is enforced only for active (not soft-deleted) boxes.
10. Stream logs through API SSE (`GET /v1/boxes/:boxId/logs?follow=true`) or CLI: `... logs -f <boxId|name>`.
11. Box list/detail reads (`GET /v1/boxes`, `GET /v1/boxes/:boxId`) reconcile persisted status with current Docker container state.
12. In web UI, `Stop` is enabled only for `running` boxes; API stop remains idempotent when Docker reports an already-stopped container.
