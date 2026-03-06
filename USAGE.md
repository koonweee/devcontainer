# Setting up
## For development
1. Install Node.js 22+ and Docker.
2. Install dependencies: `npm install`.
3. Review env defaults in `ENV.md`; set workspace-runtime env values in `docker/runtime/runtime.env` as needed.
4. Build the local box image: `npm run build:runtime-image`.
   - This builds the workspace image from `docker/runtime/Dockerfile`.
5. Generate contracts: `npm run gen:client`.
6. Start API and web with hot reload:
   ```sh
   npm run dev
   ```
   Or run individually: `npm run dev:api`, `npm run dev:web`, `npm run dev:cli`.
7. Open `http://localhost:5173`.
   - API changes trigger automatic restart via `tsx watch`.
   - Web changes apply instantly via Vite HMR.
8. Configure Tailscale before creating boxes:
   - Web: complete the setup form shown on first load.
   - CLI: `npm run -w @devbox/cli start -- setup tailnet --tailnet <tailnet> --client-id <id> --client-secret <secret>`
   - `tailnet` value: use your Tailnet ID from Tailscale Admin -> Settings -> General.
     - Typical values: `example.com` or `user@example.com`.
   - OAuth client scopes required by this platform:
     - `auth_keys` write
     - `devices:core` write
   - Ensure your ACL `tagOwners` allows configured tags (default `tag:devcontainer`), for example:
     - `"tagOwners": { "tag:devcontainer": ["autogroup:admin", "tag:devcontainer"] }`
9. Verify changes: `npm run typecheck && npm run test`.
10. Match CI locally before opening a PR: `npm run lint && npm run test && npm run build && npm run check:client`.

## For deployment
1. Build and publish the workspace image, then set `DEVBOX_RUNTIME_IMAGE` to that tag or digest.
2. Configure deployment env values in `ENV.md` and set workspace-runtime envs in `docker/runtime/runtime.env`.
3. Deploy `api` and `web` as separate containers/services, and mount persistent storage for SQLite at `DEVBOX_DB_PATH`.
4. Ensure API container can access `/var/run/docker.sock`; do not grant that mount to web or CLI.
5. Run post-deploy checks: API health, create/list/start/stop/remove flows, and logs/status streaming.

# User flows

## Tailnet setup
- Configure once via web setup form or CLI `devbox setup tailnet`.
- OAuth scopes required: `auth_keys` write and `devices:core` write.
- ACL must allow configured tags in `tagOwners` (default tag: `tag:devcontainer`).
- Tailscale SSH access is controlled by Tailscale SSH policy (`ssh` rules).
  - Docs: https://tailscale.com/kb/1193/tailscale-ssh
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
   - Web: subscribes after hydration and applies `box.updated` and `box.removed` events directly; status and removals stream live without per-event full-list polling.
4. Connect over Tailnet SSH:
   - Use the box hostname shown as `tailnetUrl`.
   - Tailscale SSH terminates directly in the workspace container.
   - Using Tailscale also makes it straightforward to reach development services started inside the box, such as local web apps, over the box's Tailnet hostname or IP when ACLs allow it.
   - Networking guarantees for boxes:
     - Boxes are isolated from each other at the Docker network layer.
     - Boxes may still reach each other over Tailscale if ACLs allow it.
     - Boxes do not publish Docker host ports.
     - Services started inside a box may be reachable over that box’s Tailnet address.
     - Because the workspace keeps full `sudo`, a user inside the box can still change box-local networking behavior such as starting extra listeners, adding port forwards or proxies, and altering routes or firewall rules inside that box.
5. Stream box logs:
   - API SSE: `GET /v1/boxes/:boxId/logs?follow=true&tail=200&since=<iso-or-unix-seconds>`
   - CLI snapshot default: `npm run -w @devbox/cli start -- logs <boxId|name>`
   - CLI follow: `npm run -w @devbox/cli start -- logs -f <boxId|name>`
   - CLI bounded history: `npm run -w @devbox/cli start -- logs <boxId|name> --tail 200 --since 2026-01-01T00:00:00Z`
   - Web: click `View logs` on any box to open tabbed log viewers; tabs keep per-box buffers in memory, and follow mode is opt-in per tab.
6. Stop a box:
   - API: `POST /v1/boxes/:boxId/stop`
   - CLI: `npm run -w @devbox/cli start -- stop <boxId|name>`
7. Start a stopped box:
   - API: `POST /v1/boxes/:boxId/start`
   - Web: start button shown when box status is `stopped`
   - CLI: `npm run -w @devbox/cli start -- start <boxId|name>`
8. Remove a box:
   - API: `DELETE /v1/boxes/:boxId`
   - Behavior: API remove cleans up the workspace container, per-box network, and per-box volume.
   - CLI: `npm run -w @devbox/cli start -- rm <boxId|name>`

## Networking and isolation guarantees
- The platform does not publish box services on Docker host ports, does not use host networking for boxes, does not attach boxes to arbitrary shared Docker networks, and does not provide expose-service, reverse-proxy, tunnel, or sidecar helpers for boxes.
- Platform-managed access is limited to the box's Tailscale identity. The orchestrator also does not mount `docker.sock` or other host bind mounts into boxes.
- These guarantees apply at the orchestrator/Docker boundary. A privileged developer inside a box may still intentionally widen that box's own reachability by running software inside the box.
- That box-local behavior is out of scope for platform enforcement, but it should not let the box affect the Docker host, the orchestrator, or other boxes through the platform layer.
