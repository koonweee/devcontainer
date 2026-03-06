## Motivation
- The branch evolved beyond the earlier sidecar-based Tailscale runtime and now converges on a simpler single-container runtime model.
- We need a PR description that reflects the full branch scope (runtime model changes, API/orchestrator contract updates, docs, and tests), not only the README edit.

## What changed in this branch

### 1) Runtime direction change: sidecar namespace ➜ single managed workspace container
- Final direction in this branch is a **single dev box container** that runs the developer workspace and Tailscale in the same runtime.
- Removed separate runtime SSHD config file and adjusted runtime image/entrypoint behavior accordingly.
- Updated runtime/image build wiring and related scripts to match the single-container model.

### 2) Orchestrator/runtime behavior and cleanup hardening
- Updated orchestrator/runtime types and implementations to reflect the final single-container lifecycle semantics.
- Strengthened lifecycle and cleanup behavior (including log stream/runtime handling) across orchestrator and Docker runtime integration.
- Updated in-memory and sqlite repository/testing support paths for the new lifecycle shape.

### 3) API + contract updates
- Updated Fastify routes/schemas and regenerated OpenAPI artifacts to align with new runtime behavior.
- Updated generated shared API client package so web/CLI consume the current contract.

### 4) Web/CLI state handling updates
- Updated web store transition behavior and related tests.
- Updated CLI tests and API-route tests to match new response/state expectations.

### 5) Documentation updates
- Updated canonical docs to reflect the final direction and keep documentation aligned with implementation:
  - `README.md`
  - `USAGE.md`
  - `ARCHITECTURE.md`
  - `ENV.md`
  - `.env.example`
- `README.md` remains an entrypoint doc and links to canonical docs for detailed behavior.

## Functional changes after implementation
- Dev boxes run as single managed workspace containers with Tailscale-enabled access in that runtime.
- Box lifecycle/log/status behavior aligns to the unified runtime model and updated API contract.
- User/operator documentation now describes the final single-container setup and usage path.

## High-ROI tests
- Orchestrator unit tests covering lifecycle + runtime entrypoint behavior.
- Fastify route tests (`inject`) validating contract and endpoint semantics.
- Web/CLI state and behavior tests covering updated transition expectations.

## Canonical docs updated (and why)
- `README.md`: kept as brief navigation/entrypoint aligned to final runtime direction.
- `USAGE.md`: updated setup and user-flow guidance for final runtime model.
- `ARCHITECTURE.md`: updated boundaries/responsibilities after runtime direction shift.
- `ENV.md` + `.env.example`: updated env contract to match runtime/API behavior.

## Duplication check
- No new canonical-doc duplication introduced: README summarizes and links; detailed setup/architecture/env content remains in `USAGE.md`, `ARCHITECTURE.md`, and `ENV.md`.
