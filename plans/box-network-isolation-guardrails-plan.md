---
status: implemented
owner: codex
created: 2026-03-06
updated: 2026-03-06
---

# Lock box networking and Docker-layer isolation invariants

## Summary
Add one box-specific runtime boundary inside `packages/orchestrator` so forbidden Docker exposure states cannot be expressed by box creation code.
Validate those same invariants during read/reconcile so unexpected Docker-layer drift is surfaced as `error` instead of being silently trusted.
Document the guarantees and non-guarantees in the canonical user and architecture docs without expanding repo-wide setup or env docs.

## Decisions locked in this plan
- Enforce platform invariants at the orchestrator/Docker boundary; do not attempt to police software a privileged developer intentionally runs inside the box.
- Use an allowlist-only box runtime contract: workspace volume plus the existing `/dev/net/tun` device only; reject all other host binds/devices.
- On invariant drift detected at inspect/reconcile time, mark the box `error`, keep the record/container id, and refuse managed operations on that container; do not auto-delete it.
- Do not add ingress, reverse proxy, tunnel, “expose service”, sidecar, or shared-network features to the box runtime contract.
- Do not change the external create-box API shape unless needed; current API already avoids user-supplied networking knobs.

## Public APIs, interfaces, and types
- Internal TypeScript change: replace the generic `createContainer(options)` path in [`packages/orchestrator/src/runtime.ts`](../packages/orchestrator/src/runtime.ts) with a box-specific `createBoxContainer(options)` contract and `CreateBoxContainerOptions`.
- Internal TypeScript change: extend inspected runtime details with the fields required to validate isolation (`networkMode`, `attachedNetworks`, `publishedPorts`, `exposedPorts`, `mounts`, `devices`, `capAdd`, `privileged`).
- External OpenAPI/API change: none. `POST /v1/boxes` remains limited to `name`, `command`, and `env`.
- Boundary rule: future sidecars, proxies, host mounts, or shared-network features must introduce a separately reviewed abstraction instead of extending the box-safe box contract.

## Implementation phases
1. Introduce a box-safe runtime contract.
   - Add a shared box runtime policy helper in [`packages/orchestrator/src/box-runtime.ts`](../packages/orchestrator/src/box-runtime.ts).
   - Restrict box creation inputs to name, image, dedicated network, workspace volume, labels, env, and command.
   - Remove low-level box creation escape hatches for ports, exposed ports, network overrides, shared network attachments, bind mounts, sidecars, docker.sock mounts, arbitrary devices, and arbitrary capabilities.
   - Update [`packages/orchestrator/src/orchestrator.ts`](../packages/orchestrator/src/orchestrator.ts) to call only `createBoxContainer(...)`.

2. Centralize the isolation policy in one reusable helper.
   - Build one approved Docker create payload shape in [`packages/orchestrator/src/box-runtime.ts`](../packages/orchestrator/src/box-runtime.ts):
     - only the managed named volume mounted at `/workspace`
     - `HostConfig.NetworkMode` set to the box’s dedicated network
     - no port publishing, exposed ports, bind mounts, links, extra hosts, PID/IPC/UTS overrides, or privileged mode
     - only `/dev/net/tun`
     - only `NET_ADMIN` and `NET_RAW`
   - Use the same helper to validate inspected container details.

3. Add read/reconcile-time invariant verification.
   - Extend inspect support in [`packages/orchestrator/src/dockerode-runtime.ts`](../packages/orchestrator/src/dockerode-runtime.ts) and [`packages/orchestrator/src/testing/mock-runtime.ts`](../packages/orchestrator/src/testing/mock-runtime.ts) with isolation-relevant fields.
   - In [`packages/orchestrator/src/orchestrator.ts`](../packages/orchestrator/src/orchestrator.ts), validate:
     - managed labels still present
     - no host networking
     - exactly one approved network attachment and expected `NetworkMode`
     - no published or exposed ports
     - no host bind mounts and no docker control-plane socket mounts
     - only approved devices/capabilities
   - If validation fails, mark the box `error`, log the invariant failure, and refuse managed operations on that container.

4. Add negative regression tests.
   - [`packages/orchestrator/test/dockerode-runtime.test.ts`](../packages/orchestrator/test/dockerode-runtime.test.ts): assert the Docker create payload omits forbidden exposure fields and includes only the approved mount/network/device/capability shape.
   - [`packages/orchestrator/test/orchestrator.test.ts`](../packages/orchestrator/test/orchestrator.test.ts): add negative reconcile and operation tests for host networking, published ports, exposed ports, unexpected network attachments, docker socket mounts, unexpected bind mounts, and unexpected device/capability drift.
   - [`apps/api/test/routes.test.ts`](../apps/api/test/routes.test.ts): add request-level negative tests proving `POST /v1/boxes` still rejects unexpected networking/exposure fields.

5. Update canonical docs.
   - [`ARCHITECTURE.md`](../ARCHITECTURE.md): document platform-enforced Docker/orchestrator isolation guarantees and the developer-controlled boundary inside a box.
   - [`USAGE.md`](../USAGE.md): document user-facing guarantees and non-guarantees for networking and exposure.
   - [`README.md`](../README.md): add a short navigation link for networking/security guarantees.

6. Verification and completion.
   - Run targeted package tests and typechecks, then repo-level verification.
   - Review whether `USAGE.md` and `ARCHITECTURE.md` need any further tightening.
   - Confirm which canonical docs changed and why, with no duplicated canonical content introduced.
   - Mark the plan implemented.

## Exact invariants after implementation
- Box workloads cannot be created with Docker host port publishing or Docker exposed ports through the box runtime/orchestrator path.
- Box workloads cannot use host networking.
- Box workloads cannot attach to arbitrary/shared Docker networks outside the approved one-network-per-box model.
- Box workloads cannot receive orchestrator-managed ingress, reverse proxy, tunnel, or sidecar/service-exposure helpers through the box runtime contract.
- Box workloads cannot receive docker.sock or other host bind mounts through the box runtime contract.
- Box workloads cannot receive unapproved host devices/capabilities beyond the current Tailscale requirement.
- Platform-provided reachability remains limited to the box’s Tailscale identity.

## Exact negative tests after implementation
- Creating a box never sends `PortBindings`, `PublishAllPorts`, `ExposedPorts`, host networking, bind mounts, or extra network attachments to Docker.
- Reconcile marks a box `error` if inspect shows host networking.
- Reconcile marks a box `error` if inspect shows published or exposed ports.
- Reconcile marks a box `error` if inspect shows docker.sock or any unexpected host bind mount.
- Reconcile marks a box `error` if inspect shows an unexpected attached network or network mode.
- Managed operations refuse to act on a container that fails isolation validation.
- API rejects create payloads that attempt to smuggle networking/exposure settings.

## User-facing guarantees and non-guarantees
- Guarantee: the platform does not publish box services on Docker host ports, does not provide expose-service helpers, does not use host networking for boxes, and does not hand boxes docker.sock.
- Guarantee: at the orchestrator/Docker layer, boxes are isolated from the host and from other boxes except for the explicitly modeled per-box network and Tailscale access path.
- Non-guarantee: a privileged developer inside their own box may intentionally run software that widens that box’s own reachability.
- Non-guarantee: the platform does not attempt to stop intentional box-local proxies or tunnels started from inside the box.
- Boundary statement: those in-box actions must not grant control over the Docker host, the orchestrator, or other boxes.

## Tradeoffs and migration risk
- The main code risk is the internal runtime interface rename, but the caller set is small and localized to the orchestrator runtime adapter path.
- Existing drifted containers now surface as `error` when reconciliation sees forbidden Docker-layer state. That is intentional and should be called out in change notes.
- The allowlist-only host mount/device rule intentionally blocks future host integrations from silently piggybacking on the box runtime.
- This work does not add Docker network peer inspection. If a future requirement needs stronger cross-network auditing, it should be a separate change.

## Functional changes after implementation
- Box creation is structurally unable to express forbidden Docker-layer exposure settings.
- Runtime reconciliation detects and surfaces container isolation drift instead of trusting inspected containers solely by label.
- Repo users have a brief, canonical statement of the platform’s guarantees and non-guarantees.

## High-ROI tests
- `npm test --workspace @devbox/orchestrator`
- `npm test --workspace @devbox/api`
- `npm run typecheck --workspace @devbox/orchestrator`
- `npm run typecheck --workspace @devbox/api`

## Assumptions and defaults
- Tailscale remains the only platform-provided reachability path for boxes.
- The existing runtime-entrypoint firewall behavior remains acceptable for this change.
- No OpenAPI/client regeneration is needed because the external create-box contract did not change.
