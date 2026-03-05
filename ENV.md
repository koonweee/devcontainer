# Environment variables

Canonical reference for runtime environment variables and defaults.

## Required
- Local development: none.
- Deployment: set required-by-context values when defaults do not match your network/storage layout.

## Required by context
- `DEVBOX_RUNTIME_IMAGE`
  - Set this in deployment to a published runtime image tag/digest.
- `DEVBOX_PUBLIC_API_URL`
  - Set this when browser clients cannot reach API at the default.
- `DEVBOX_INTERNAL_API_URL`
  - Set this when web server-side calls should target service DNS/internal network.
- `DEVBOX_API_URL`
  - Set this when CLI should target a non-local API.
- `DEVBOX_DB_PATH`
  - Set this when default SQLite path does not match your persistent storage mount.

## Optional (with defaults)
- `DEVBOX_DB_PATH` (default: `devbox.sqlite` in process cwd; Compose sets `/data/devbox.sqlite`)
  - SQLite file location used by orchestrator state repositories.
  - Recommendation: use a persistent volume-backed path in containers.

- `DEVBOX_RUNTIME_IMAGE` (default: `devbox-runtime:local`)
  - Fixed Docker image used for all box creation requests.
  - Recommendation: build/tag from `docker/runtime/Dockerfile` before starting API (`npm run build:runtime-image`).

- `DEVBOX_RUNTIME_ENV_FILE` (default fallback resolves `docker/runtime/runtime.env` from repo)
  - File path containing env entries to inject into every created box.
  - Recommendation: keep box-runtime env in `docker/runtime/runtime.env` instead of root `.env`.
  - Example file entries: `DEV_PASSWORD=password`, `TZ=UTC`.

- `DEVBOX_INTERNAL_API_URL` (default: `http://localhost:3000`)
  - Used by web SSR/server-side requests to reach the API.
  - Recommendation: in Compose, use service DNS (`http://api:3000`).

- `DEVBOX_PUBLIC_API_URL` (default: `http://localhost:3000`)
  - Used by browser-side web calls/SSE.
  - Recommendation: set to your externally reachable API URL.

- `DEVBOX_API_URL` (default: `http://localhost:3000`)
  - CLI API base URL.
  - Recommendation: point to your deployed API endpoint when using CLI remotely.

- `DEVBOX_WEB_ORIGIN` (default: `http://localhost:5173,http://localhost:4173`)
  - API CORS allowlist for web origins (comma-separated).
  - Recommendation: include every browser origin that should call API directly.

## Runtime container env (injected by orchestrator into each box)
These are set automatically by the orchestrator when Tailscale is configured. They are not user-configurable env vars.

- `DEVBOX_TAILSCALE_AUTHKEY` - Per-box Tailscale auth key (minted at create time, never persisted)
- `DEVBOX_TAILSCALE_HOSTNAME` - Tailscale hostname for the box (e.g. `devbox-mybox-a1b2c3d4`)

## Notes
- API bind/port are fixed by the service (`0.0.0.0:3000`) and are not configured through env vars.
- Keep runtime container env entries in `docker/runtime/runtime.env`.
- Tailscale runtime state path is fixed at `/workspace/.tailscale` inside each box (not user-configurable).
- Tailnet credentials (OAuth client ID/secret) are stored in the SQLite database, not in env vars. Configure them via the web UI setup form or `devbox setup tailnet` CLI command.
- Tailscale OAuth client must include `auth_keys` write and `devices:core` write scopes.
- Tailnet ACL `tagOwners` must allow configured device tags (default `tag:devcontainer`).
- For setup steps and operational flows, use `USAGE.md`.
