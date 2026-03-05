# Environment variables

This project is set up so local development works without custom env configuration.

## Required
- Local development: none.
- Production/deployment: set values only when defaults do not match your network/storage layout.

## Optional (with defaults)
- API bind/port are fixed by the service (`0.0.0.0:3000`) and not user-configurable env vars.
- Recommendation: remap published ports in Compose/ingress instead of changing API process bind settings.

- `DEVBOX_DB_PATH` (default: `devbox.sqlite` in process cwd; Compose sets `/data/devbox.sqlite`)
  - SQLite file location used by orchestrator state repositories.
  - Recommendation: use a persistent volume-backed path in containers.

- `DEVBOX_RUNTIME_IMAGE` (default: `devbox-runtime:local`)
  - Fixed Docker image used for all box creation requests.
  - Recommendation: build/tag from repo root Dockerfile before starting API (`npm run build:runtime-image`).

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

## Minimal configuration recommendation
1. Start with no custom env values.
2. Override only `DEVBOX_PUBLIC_API_URL` if browser clients cannot reach API at `http://localhost:3000`.
3. Override `DEVBOX_API_URL` only when CLI targets a non-local API.
4. Keep `DEVBOX_DB_PATH` default unless you have explicit storage constraints.
5. Keep `DEVBOX_RUNTIME_IMAGE` default unless you need a different tag/digest.
6. Set required runtime env entries in `docker/runtime/runtime.env` for runtime image requirements (for example, SSH password env).
