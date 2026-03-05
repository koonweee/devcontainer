# Per-Workspace Rootless Docker Daemons Plan (Debian Host, mTLS)

## Summary
Implement one rootless Docker daemon per workspace box on the Debian host. The orchestrator provisions and manages these daemons and injects per-box Docker client access (`DOCKER_HOST` + TLS certs) into each workspace container. API remains a thin wrapper over orchestrator calls, while web and CLI remain API-only.

## Functional changes after implementation
- Boxes can run `docker` and `docker compose` commands inside the workspace container.
- Each box connects only to its own workspace daemon endpoint and cert material.
- Box start flow starts workspace daemon first, then workspace container.
- Box stop flow stops workspace container first, then workspace daemon (daemon cache remains).
- Box remove flow removes workspace container/network/volume and then removes workspace daemon state/certs.

## Scope and non-goals
- In scope:
  - Orchestrator daemon manager abstraction and concrete Debian rootless implementation.
  - SQLite persistence of workspace daemon metadata.
  - Container runtime option extension for Docker client mount/env/host mapping.
  - Runtime image update to include Docker CLI and Compose plugin.
  - Tests and canonical documentation updates.
- Out of scope:
  - Tailnet identity integration.
  - Staged rollout mode, migration toggles, or dual host-socket compatibility.

## Architecture and boundaries
- Orchestration business logic remains in `packages/orchestrator`.
- Fastify API in `apps/api` stays thin and unchanged at route level.
- Web (`apps/web`) and CLI (`apps/cli`) continue as API consumers and do not access Docker directly.
- Privileged daemon lifecycle operations are performed by orchestrator running on Debian host with systemd access.

## Detailed implementation

### 1) Add daemon manager abstraction
Create `packages/orchestrator/src/workspace-daemon-manager.ts`:
- `WorkspaceDockerAccess`:
  - `dockerHost: string`
  - `tlsVerify: boolean`
  - `certMountSource: string`
  - `certMountTarget: string`
  - `extraHosts: string[]`
- `WorkspaceDaemonManager` interface:
  - `provision(boxId: string): Promise<void>`
  - `start(boxId: string): Promise<void>`
  - `stop(boxId: string): Promise<void>`
  - `teardown(boxId: string): Promise<void>`
  - `healthcheck(boxId: string): Promise<void>`
  - `dockerAccess(boxId: string): Promise<WorkspaceDockerAccess>`

Create testing helper:
- `packages/orchestrator/src/testing/mock-workspace-daemon-manager.ts`
- Deterministic no-op manager with operation log for orchestration unit tests.

### 2) Persist workspace daemon metadata in SQLite
Update `packages/orchestrator/src/repositories.ts`:
- Add `workspace_daemons` table:
  - `box_id TEXT PRIMARY KEY`
  - `port INTEGER NOT NULL UNIQUE`
  - `unit_name TEXT NOT NULL`
  - `state_dir TEXT NOT NULL`
  - `client_cert_dir TEXT NOT NULL`
  - `created_at TEXT NOT NULL`
  - `updated_at TEXT NOT NULL`
- Add repository types and implementation:
  - `WorkspaceDaemonRecordCreate`
  - `WorkspaceDaemonRecord`
  - `WorkspaceDaemonRepository` with `create/get/update/delete/list/allocatePort`.
- Add `SqliteWorkspaceDaemonRepository`.
- Extend `createSqliteRepositories` return value with `workspaceDaemons`.
- `allocatePort(min, max)` scans used ports and returns lowest free; throws when exhausted.

### 3) Implement Debian rootless daemon manager (systemd + TLS)
Create `packages/orchestrator/src/debian-rootless-daemon-manager.ts`:
- Constructor inputs:
  - `workspaceDaemons` repository
  - `stateRoot` default `/var/lib/devbox-daemons`
  - `portMin` default `24000`
  - `portMax` default `24999`
  - `daemonHost` default `host.docker.internal`
  - command runner abstraction
- Directory layout:
  - CA dir: `${stateRoot}/ca`
  - Per-box dir: `${stateRoot}/boxes/<boxId>/`
  - server certs: `${stateDir}/server`
  - client certs: `${stateDir}/client`
- `provision(boxId)`:
  - allocate port via repository.
  - create dirs with `0700`.
  - ensure CA key/cert exists (create with `openssl` if missing).
  - create server key/cert and client key/cert signed by CA.
  - write/record unit name `devbox-dockerd-<boxId>.service`.
  - persist metadata row.
- Unit command characteristics:
  - rootless `dockerd`
  - unique `--data-root`, `--exec-root`, `--pidfile`
  - `--host=tcp://127.0.0.1:<port>`
  - `--tlsverify --tlscacert --tlscert --tlskey`
- `start/stop`:
  - use `systemctl start|stop <unit>`.
- `healthcheck`:
  - run Docker ping with per-box client certs against daemon endpoint.
- `dockerAccess(boxId)`:
  - returns `DOCKER_HOST` for workspace: `tcp://host.docker.internal:<port>`
  - returns client cert mount source/target and `host-gateway` mapping.
- `teardown(boxId)`:
  - stop unit, disable if needed, remove unit file, remove per-box state dir, remove repository row.

Create command helper:
- `packages/orchestrator/src/shell-command-runner.ts`
- Minimal wrapper around `spawn` to run non-interactive commands with captured stderr/stdout.

### 4) Extend runtime container creation options
Update `packages/orchestrator/src/runtime.ts`:
- Extend `CreateContainerOptions`:
  - `bindMounts?: Array<{ source: string; target: string; readOnly?: boolean }>`
  - `extraHosts?: string[]`

Update `packages/orchestrator/src/dockerode-runtime.ts`:
- Preserve existing workspace volume mount.
- Append `bindMounts` into `HostConfig.Mounts`.
- Set `HostConfig.ExtraHosts` from `extraHosts`.
- Keep existing behavior unchanged when new fields are absent.

### 5) Wire daemon lifecycle into orchestrator jobs
Update `packages/orchestrator/src/orchestrator.ts`:
- Constructor adds `workspaceDaemonManager` dependency.
- `createBox` job order:
  - progress: provision daemon.
  - start daemon.
  - daemon healthcheck.
  - resolve `dockerAccess`.
  - create workspace container with merged env/mounts/extraHosts:
    - `DOCKER_HOST=<dockerAccess.dockerHost>`
    - `DOCKER_TLS_VERIFY=1` when `tlsVerify=true`
    - `DOCKER_CERT_PATH=<dockerAccess.certMountTarget>`
  - start container.
- `startBox`:
  - start daemon + healthcheck before container start.
- `stopBox`:
  - stop container then daemon.
- `removeBox`:
  - remove workspace resources first, then daemon teardown.
- On failures:
  - keep existing `error` box status behavior.
  - best-effort cleanup for daemon resources where safe.

### 6) Wire factory and env configuration
Update `packages/orchestrator/src/factory.ts`:
- Read env vars:
  - `DEVBOX_DAEMON_STATE_ROOT` default `/var/lib/devbox-daemons`
  - `DEVBOX_DAEMON_PORT_MIN` default `24000`
  - `DEVBOX_DAEMON_PORT_MAX` default `24999`
  - `DEVBOX_DAEMON_HOST` default `host.docker.internal`
- Instantiate `DebianRootlessWorkspaceDaemonManager`.
- Pass manager and `workspaceDaemons` repo into orchestrator.

### 7) Add Docker CLI + Compose plugin to runtime image
Update `docker/runtime/Dockerfile`:
- Install Docker CLI and Compose plugin packages.
- Keep entrypoint unchanged.
- Do not install/run Docker daemon inside workspace image.

## Tests (high-ROI)

### Orchestrator unit tests
Update `packages/orchestrator/test/orchestrator.test.ts`:
- create job calls daemon manager in sequence before container start.
- start job calls daemon start before container start.
- stop job stops daemon after container stop.
- remove job tears down daemon and removes metadata.
- failure scenarios mark box as `error` and avoid orphaning daemon metadata.

### Daemon manager unit tests
Add `packages/orchestrator/test/debian-rootless-daemon-manager.test.ts`:
- unique port allocation and exhaustion path.
- generated unit content has expected `dockerd` flags.
- cert generation creates expected files/permissions.
- healthcheck error propagates.

### Runtime adapter tests
Update `packages/orchestrator/test/dockerode-runtime.test.ts`:
- assert `createContainer` forwards extra bind mounts and `ExtraHosts`.

### API route tests
Update `apps/api/test/routes.test.ts` support harness only as needed to satisfy orchestrator constructor changes while preserving route behavior assertions.

### Debian smoke checks (manual/CI target host)
- create box.
- SSH into box.
- run `docker run --rm hello-world`.
- ensure box A certs cannot control box B daemon endpoint.

## Canonical documentation update steps
1. Update `USAGE.md`:
   - Debian prerequisites for rootless per-workspace daemon setup.
   - User workflow for running Docker inside boxes.
2. Update `ARCHITECTURE.md`:
   - Replace single `docker.sock` model with per-workspace daemon model.
   - Add updated boundary diagram.
3. Update `ENV.md` and `.env.example`:
   - document daemon manager env vars and defaults.
4. Keep `README.md` as navigation only; do not add detailed setup internals there.

## Acceptance criteria
- Existing API endpoints and generated client remain usable without contract breakage.
- Newly created boxes can run Docker/Compose commands.
- Web/CLI still never access Docker directly.
- Each box can only control its own daemon endpoint.
- Removing a box removes its daemon metadata and local daemon state.

## Final implementation review checklist
- Confirm whether `USAGE.md` needs further updates after implementation.
- Confirm whether `ARCHITECTURE.md` needs further updates after implementation.
- PR notes must list exactly which canonical docs were changed and why.
- Confirm no duplicated canonical content was introduced.
