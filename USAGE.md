# Setting up
## For development
1. Install Node.js 22+ and Docker.
2. Install dependencies: `npm install`.
3. Review env defaults in `ENV.md`; set runtime box env values in `docker/runtime/runtime.env` as needed.
4. Build the runtime image from `docker/runtime/Dockerfile`: `npm run build:runtime-image`.
5. Generate contracts: `npm run gen:client`.
6. Start API and web with hot reload:
   ```sh
   npm run dev
   ```
   Or run individually: `npm run dev:api`, `npm run dev:web`, `npm run dev:cli`.
7. Open `http://localhost:5173`.
   - API changes trigger automatic restart via `tsx watch`.
   - Web changes apply instantly via Vite HMR.
8. Configure Tailscale (required before creating boxes):
   - Web: complete the setup form shown on first load.
   - CLI: `npm run -w @devbox/cli start -- setup tailnet --tailnet <tailnet> --client-id <id> --client-secret <secret>`
   - Requires a Tailscale OAuth client with device write scope and appropriate tags.
9. Verify changes: `npm run typecheck && npm run test`.
10. Match CI locally before opening a PR: `npm run lint && npm run test && npm run build && npm run check:client`.

## For deployment
1. Build and publish your runtime box image from `docker/runtime/Dockerfile` (or equivalent CI build), then set `DEVBOX_RUNTIME_IMAGE` to that tag/digest.
2. Configure deployment env values in `ENV.md` and set box-runtime envs in `docker/runtime/runtime.env`.
3. Deploy `api` and `web` as separate containers/services, and mount persistent storage for SQLite at `DEVBOX_DB_PATH`.
4. Ensure API container can access `/var/run/docker.sock`; do not grant that mount to web/CLI.
5. Run post-deploy checks: API health, create/list/start/stop/remove flows, and logs/status streaming.

# User flows

## Tailnet setup
- Configure once via web setup form or CLI `devbox setup tailnet`.
- Config is locked while boxes exist (delete all boxes to reconfigure).
- Check status: `devbox setup status` or `GET /v1/tailnet/config`.
- Clear config: `devbox setup clear` or `DELETE /v1/tailnet/config`.

## Box lifecycle
1. Create a box:
   - API: `POST /v1/boxes`
   - Web: create form in UI
   - CLI: `npm run -w @devbox/cli start -- create -n my-box`
2. List boxes:
   - API: `GET /v1/boxes`
   - CLI: `npm run -w @devbox/cli start -- ls`
3. Watch live status updates:
   - API SSE: `GET /v1/events`
   - Web: subscribes after hydration and applies `box.updated` and `box.removed` events directly; status and removals stream live without per-event full-list polling (external container deletion removes the box from state).
4. Stream box logs:
   - API SSE: `GET /v1/boxes/:boxId/logs?follow=true&tail=200&since=<iso-or-unix-seconds>`
   - CLI snapshot default: `npm run -w @devbox/cli start -- logs <boxId|name>`
   - CLI follow: `npm run -w @devbox/cli start -- logs -f <boxId|name>`
   - CLI bounded history: `npm run -w @devbox/cli start -- logs <boxId|name> --tail 200 --since 2026-01-01T00:00:00Z`
   - Web: click `View logs` on any box to open tabbed log viewers; tabs keep per-box buffers in memory, and follow mode is opt-in per tab.
5. Stop a box:
   - API: `POST /v1/boxes/:boxId/stop`
   - CLI: `npm run -w @devbox/cli start -- stop <boxId|name>`
6. Start a stopped box:
   - API: `POST /v1/boxes/:boxId/start`
   - Web: start button shown when box status is `stopped`
   - CLI: `npm run -w @devbox/cli start -- start <boxId|name>`
7. Remove a box:
   - API: `DELETE /v1/boxes/:boxId`
   - Behavior: API remove performs stop-then-remove for managed containers before network/volume cleanup.
   - CLI: `npm run -w @devbox/cli start -- rm <boxId|name>`
