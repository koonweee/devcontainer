# AGENTS.md

This repo builds a Docker-image-based dev box platform. Keep implementations simple, modular, and safe.

## Architecture guardrails
- Put orchestration business logic in a **framework-agnostic TypeScript library package**.
- Fastify API must be a **thin wrapper** around orchestrator library calls.
- Web app must be **SvelteKit** and must **never** access `docker.sock`; it only calls the API.
- CLI must be an **API client only** (no direct Docker socket, no direct DB access).
- Deploy orchestrator/API container separately from web container.

## Required repo docs maintenance
- Single source of truth policy:
  - `README.md` is entrypoint/navigation only.
    - Must include: short project description, component list, and links to canonical docs.
    - Must not include: detailed setup steps, deep architecture behavior, or env variable catalogs.
  - `USAGE.md` is setup and user workflow instructions only.
    - Must contain exactly 2 top-level sections: **Setting up** and **User flows**.
    - `Setting up` must be split into: **For development** and **For deployment**.
    - Must not include deep implementation internals.
  - `ARCHITECTURE.md` is boundaries and component responsibilities only.
    - Keep it brief; include structure and links to code where helpful.
    - Prefer diagrams for component/flow explanations when useful.
    - Must not include step-by-step setup commands or runbooks.
  - `ENV.md` is the environment variable reference.
    - Must include required/optional/default/recommendation context.
    - Must not duplicate architecture narratives or setup walkthroughs.
  - `.env.example` is for required variables (or explicitly required-by-context variables), not every optional toggle.
  - `plans/*.md` are planning artifacts and are non-canonical for current runtime/setup behavior.
- Anti-duplication rules:
  - If content belongs to another canonical doc, link to it instead of restating it.
  - Prefer brief summaries plus links over copied detail.
- Doc-change trigger checklist:
  - Setup flow changed: update `USAGE.md`.
  - Architecture boundary changed: update `ARCHITECTURE.md`.
  - Env contract changed: update `ENV.md` and `.env.example`.
  - README updates should stay as links/summaries unless onboarding entrypoints changed.
- Exception for env-only changes:
  - Update `ENV.md` and `.env.example` only.
  - Update `USAGE.md` / `ARCHITECTURE.md` only if setup flow or architecture boundaries changed.
- Every plan must include explicit steps to update `USAGE.md` and `ARCHITECTURE.md`.
- Every implementation must end with a review of whether `USAGE.md` / `ARCHITECTURE.md` need further updates.
- PR completion gate:
  - List exactly which canonical docs were updated and why.
  - Confirm no duplicated canonical content was introduced.

## Security and privileged boundary
- Treat `docker.sock` access as privileged.
- Never expose generic Docker passthrough endpoints.
- Allowlist operations and sanitize/validate all inputs.
- Use Docker labels to track ownership and restrict operations to managed resources.

## Realtime and jobs
- Represent long-running operations as jobs with progress + status.
- Prefer Server-Sent Events (SSE) for realtime updates.
- Use WebSockets only if a concrete requirement cannot be met by SSE.

## Types and contracts
- API contract source of truth is OpenAPI.
- Generate and use one shared typed API client package for both web and CLI.
- Avoid patterns that tightly couple API internals to one client type.

## SvelteKit SSR guidance and anti-patterns
- Use SSR for initial shell/auth gating/initial fetch only.
- Use client-side SSE after hydration for live state.
- Anti-patterns to avoid:
  - No business logic in `+page.server.ts` as Docker proxy.
  - No confusing mixed server/client state ownership.
  - No SSR-based “live” updates.
  - No ad-hoc per-page fetch wrappers.
  - No bypassing generated OpenAPI client.
- Keep pages thin; use client stores for SSE-driven state.

## Simplicity and testing
- No Redis/external queue unless proven necessary; start with DB + in-process job runner.
- Keep test-only implementations in `packages/*/src/testing`.
- Do not export test doubles from package root exports; expose them through explicit testing entrypoints.
- Keep production modules free of test harness constructors; place harness setup in `apps/*/test/support`.
- Add basic tests early for TDD:
  - orchestrator unit tests
  - Fastify route tests (`inject`)
  - optional minimal integration smoke tests
- CI should run lint, typecheck, tests, and client generation checks.

## Maintainability
- Minimize user configuration surface; prefer zero-config defaults unless an env variable provides clear operational value.
- Add brief JSDoc to each class describing intent; keep class JSDoc to 20 words or fewer.

## Plan quality requirements
- Every plan must include a short **"Functional changes after implementation"** section that states user-visible behavior changes.
- Every plan must include **high-ROI tests** (small number, high confidence) tied to the most critical risks and core user flows.
