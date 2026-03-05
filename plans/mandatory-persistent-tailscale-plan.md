---
status: proposed
owner: codex
created: 2026-03-05
updated: 2026-03-05
---

# Mandatory persistent Tailscale for dev boxes with deterministic cleanup and onboarding config

## Summary
Implement Tailscale as a required path for every box (no enable flag), using persistent nodes (not ephemeral), with inbound restricted to Tailnet traffic only.
Move Tailscale OAuth configuration to onboarding flows (web + CLI) backed by orchestrator-managed storage.
Add deterministic Tailscale cleanup using persisted node identity, including cleanup when containers are externally deleted.

## Goals
- Every created box appears on Tailscale as a persistent managed node.
- Box inbound is limited to `tailscale0` plus loopback and established traffic.
- Tailnet credentials/tags are configured once through onboarding and locked while any boxes exist.
- Tailscale cleanup is automatic on normal remove and external-delete reconciliation.

## Non-goals
- Shipping production auth in this change.
- Multi-tenant per-user Tailnet config.
- Replacing SSE with WebSockets.

## Product decisions
- No `DEVBOX_TAILSCALE_ENABLED`; Tailscale is mandatory for box lifecycle.
- Persistent nodes are required:
  - `reusable=false`
  - `ephemeral=false`
  - `preauthorized=true`
- No bootstrap token.
- Tailnet config updates are blocked whenever any box exists.
- Cleanup maps by persisted Tailscale node identity first; hostname fallback is warning-only.
- External container deletion must trigger Tailscale + Docker resource cleanup automatically.

## Public API/interfaces/types changes
- Extend `Box` with:
  - `tailnetNodeId: string | null`
- Add Tailnet config endpoints:
  - `GET /v1/tailnet/config`
  - `PUT /v1/tailnet/config`
  - `DELETE /v1/tailnet/config`
  - Optional: `POST /v1/tailnet/config/validate`
- Add orchestrator repository contract for persisted Tailnet config.
- Regenerate OpenAPI and shared typed API client.

## Implementation steps
1. Extend orchestrator data model and repositories.
   - Add `tailnet_node_id` column to `boxes`.
   - Add single-row `tailnet_config` table with:
     - `tailnet`
     - `oauth_client_id`
     - `oauth_client_secret`
     - `tags_csv` (default `tag:devbox`)
     - `hostname_prefix` (default `devbox`)
     - `authkey_expiry_seconds` (default `600`)
     - `created_at`, `updated_at`
   - Add interfaces and implementations in:
     - `packages/orchestrator/src/repositories.ts`
     - `packages/orchestrator/src/testing/in-memory-repositories.ts`

2. Add orchestrator-internal Tailscale control-plane client.
   - Implement OAuth token exchange.
   - Implement auth key minting with persistent capabilities.
   - Implement device list/delete.
   - Enforce secret handling:
     - never persist minted keys
     - never expose OAuth secret in API responses
     - never emit secrets in logs/events/errors

3. Update `createBox` lifecycle.
   - Require Tailnet config; fail fast with onboarding-required error if missing.
   - Mint per-box auth key.
   - Build deterministic hostname `<hostnamePrefix>-<boxName>-<shortId>`.
   - Inject runtime env:
     - `DEVBOX_TAILSCALE_AUTHKEY`
     - `DEVBOX_TAILSCALE_HOSTNAME`
     - `DEVBOX_TAILSCALE_STATE_DIR=/workspace/.tailscale`
     - `DEVBOX_TAILSCALE_ENFORCE_INBOUND_TAILNET_ONLY=true`
   - Set `tailnetUrl` to `ssh://<hostname>`.
   - After start, fetch `tailscale status --json` inside container and persist `Self.ID` as `tailnetNodeId`.
   - If node-id capture fails, fail create and mark box `error`.

4. Update `startBox` lifecycle.
   - Start container.
   - Refresh and persist `tailnetNodeId` (idempotent).
   - If node-id capture fails, fail start and mark box `error`.

5. Update `removeBox` lifecycle.
   - Stop and remove container.
   - Run Tailnet cleanup:
     - if `tailnetNodeId` exists: resolve `deviceId` by node-id match and delete.
     - if missing: fallback to exact hostname lookup and emit warning.
   - Remove Docker network + volume.
   - Delete box record and emit `box.removed`.
   - Treat not-found deletes as idempotent success.

6. Replace missing-container hard-delete with cleanup workflow.
   - When reconcile detects missing container, enqueue `cleanup` job (deduped per box).
   - Cleanup job executes:
     - Tailnet cleanup
     - network cleanup
     - volume cleanup
     - box deletion + `box.removed`
   - Read paths remain available and non-blocking while cleanup runs.

7. Update runtime image and entrypoint for always-on Tailscale mode.
   - `docker/runtime/Dockerfile`:
     - install `tailscale`, `iptables`
   - `docker/runtime/dev-entrypoint.sh`:
     - start `tailscaled` with state dir `/workspace/.tailscale`
     - first boot: `tailscale up --ssh --authkey=... --hostname=...`
     - existing state: `tailscale up --ssh --hostname=...`
     - firewall policy:
       - allow loopback
       - allow `ESTABLISHED,RELATED`
       - allow inbound on `tailscale0`
       - drop all other inbound
     - trap shutdown and run best-effort `tailscale logout`

8. Update Docker runtime create options.
   - Always include `/dev/net/tun`.
   - Always include `NET_ADMIN` and `NET_RAW`.
   - Implement in `packages/orchestrator/src/dockerode-runtime.ts` and related runtime types/tests.

9. Add API routes and schemas.
   - Add tailnet config schemas in `apps/api/src/schemas.ts`.
   - Add routes in `apps/api/src/app.ts`.
   - Return lock conflict (`409`) with clear `boxCount` and message.
   - Keep API thin, delegating business logic to orchestrator.

10. Regenerate contracts and client.
   - `npm run gen:openapi`
   - `npm run gen:client`
   - Ensure web + CLI use shared generated API client methods for tailnet config.

11. Build onboarding UX.
   - Web (`apps/web`):
     - setup gate when Tailnet config absent
     - clear lock message: “Tailnet config is locked because N boxes exist. Remove all boxes to modify.”
     - show `tailnetUrl` in box list
   - CLI (`apps/cli`):
     - `devbox setup tailnet`
     - `devbox setup status`
     - `devbox setup clear`

12. Documentation updates.
   - `README.md`:
     - add critical banner: do not deploy to production before authN/authZ is implemented
   - `USAGE.md`:
     - add onboarding setup flow and Tailnet user flows
   - `ARCHITECTURE.md`:
     - add Tailnet config store, provisioning path, cleanup responsibilities
   - `ENV.md`:
     - keep env catalog minimal and aligned to current runtime contracts
   - Explicitly review whether further `USAGE.md` / `ARCHITECTURE.md` updates are needed at implementation end.

## Failure modes and handling
- Missing Tailnet config: create fails with actionable onboarding-required message.
- OAuth/key mint failure: create fails, box transitions to `error`.
- Post-start node-id capture failure: create/start fails, box transitions to `error`.
- Tailscale cleanup failure:
  - not-found => success
  - other errors => record warning/error in job while continuing Docker cleanup
- External-delete cleanup is idempotent and deduped.

## Functional changes after implementation
- Boxes are always Tailnet-integrated and reachable via Tailscale SSH.
- Inbound traffic to boxes is restricted to Tailnet interface traffic.
- Tailnet config is managed through onboarding API/web/CLI and locked while boxes exist.
- Box remove and external-delete reconciliation both trigger deterministic Tailnet cleanup plus Docker network/volume cleanup.

## High-ROI tests
- Orchestrator:
  - create fails when Tailnet config absent
  - persistent key capabilities (`ephemeral=false`) are used
  - node-id capture persists `tailnetNodeId`
  - config lock rejects update/delete with `boxCount`
- Orchestrator reconcile:
  - missing container enqueues cleanup job instead of hard-delete
  - cleanup removes Tailnet device, network, volume, then box row
  - duplicate events do not double-clean
- Docker runtime:
  - `/dev/net/tun` and caps are present in create options
- API route tests (`inject`):
  - tailnet config endpoint success/error/lock paths
  - onboarding-required error when creating before setup
- Web/CLI:
  - setup gate + lock messaging
  - setup/status/clear use generated client correctly

## Risks and mitigations
- Missing host `/dev/net/tun`.
  - Mitigation: fail with explicit startup/create error and actionable message.
- Auth not yet implemented.
  - Mitigation: critical README warning and deployment policy blocking production rollout until auth exists.
- Legacy boxes without `tailnetNodeId`.
  - Mitigation: one-time hostname fallback on cleanup and node-id self-heal on next successful start.
