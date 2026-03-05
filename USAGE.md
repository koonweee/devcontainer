# Setting up
## For development
1. Install Node.js 22+ and Docker.
2. Install dependencies: `npm install`.
3. Review env defaults in `ENV.md`; set runtime box env values in `docker/runtime/runtime.env` as needed.
4. Build the runtime image from `docker/runtime/Dockerfile`: `npm run build:runtime-image`.
5. Generate contracts: `npm run gen:client`.
6. Start stack: `docker compose up --build`.
7. Open the web app at `http://localhost:4173`.
8. Optional local app-only runs: `npm run -w @devbox/api dev` and `npm run -w @devbox/web dev`.
9. Verify changes: `npm run typecheck && npm run test`.
10. Match CI locally before opening a PR: `npm run lint && npm run test && npm run build && npm run check:client`.

## For deployment
1. Build and publish your runtime box image from `docker/runtime/Dockerfile` (or equivalent CI build), then set `DEVBOX_RUNTIME_IMAGE` to that tag/digest.
2. Configure deployment env values in `ENV.md` and set box-runtime envs in `docker/runtime/runtime.env`.
3. Deploy `api` and `web` as separate containers/services, and mount persistent storage for SQLite at `DEVBOX_DB_PATH`.
4. Ensure API container can access `/var/run/docker.sock`; do not grant that mount to web/CLI.
5. Run post-deploy checks: API health, create/list/stop/remove flows, and logs/status streaming.

# User flows
1. Create a box:
   - API: `POST /v1/boxes`
   - Web: create form in UI
   - CLI: `npm run -w @devbox/cli start -- create -n my-box`
2. List boxes:
   - API: `GET /v1/boxes`
   - CLI: `npm run -w @devbox/cli start -- ls`
3. Watch live status updates:
   - API SSE: `GET /v1/events`
   - Web: subscribes after hydration
4. Stream box logs:
   - API SSE: `GET /v1/boxes/:boxId/logs?follow=true`
   - CLI: `npm run -w @devbox/cli start -- logs -f <boxId|name>`
5. Stop a box:
   - API: `POST /v1/boxes/:boxId/stop`
   - CLI: `npm run -w @devbox/cli start -- stop <boxId|name>`
6. Remove a box:
   - API: `DELETE /v1/boxes/:boxId`
   - CLI: `npm run -w @devbox/cli start -- rm <boxId|name>`
