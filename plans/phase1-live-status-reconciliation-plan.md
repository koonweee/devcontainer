---
status: completed
owner: codex
created: 2026-03-05
updated: 2026-03-05
---

# Phase 1 plan: read-path live status reconciliation

## Summary
Fix stale box state by reconciling persisted box status against Docker container reality on `getBox` and `listBoxes`.

This phase is intentionally read-path only: no background workers, no Docker event stream consumer, and no job recovery loop.

## Goals
- Ensure web/CLI/API reads show accurate container lifecycle status.
- Correct stale `running` states when containers have exited.
- Keep implementation simple and low-risk for current architecture.

## Non-goals
- No continuous background sync daemon.
- No Docker event subscription (`docker events`) yet.
- No startup resume/recovery for jobs left `queued/running` after API restart.
- No network/volume reconciliation in this phase.

## Current issue
- Box status is written optimistically during jobs and persisted in SQLite.
- If a container exits after successful `startContainer`, DB state can remain `running` until another explicit write path changes it.
- Web and CLI render this stale DB state.

## Design decisions

### Reconciliation trigger points
- Trigger reconciliation in orchestrator read APIs only:
  - `listBoxes(filter?)`
  - `getBox(boxId)`

### Reconciliation scope
- Reconcile only non-deleted boxes.
- Reconcile only stable statuses: `running`, `stopped`, `error`.
- Skip transitional states: `creating`, `stopping`, `removing` to avoid fighting active jobs.

### Runtime state mapping
- Extend runtime inspect shape to include Docker container state status.
- Mapping from Docker container state to box status:
  - `running`, `restarting`, `paused`, `created` -> `running`
  - `exited` -> `stopped`
  - `dead`, `removing` -> `error`

### Missing/unmanaged container behavior
- If `containerId` exists but inspect returns 404: set `status=error`, `containerId=null`.
- If inspect returns labels that fail managed ownership check: set `status=error` (keep `containerId` as-is for diagnostics).
- If stable-status box has `containerId=null`: set `status=error`.

### Persistence and events
- Persist reconciled changes to DB immediately via `boxes.update`.
- Do not emit `box.updated` events from read-path reconciliation in phase 1 (prevents SSE refresh loops and keeps behavior deterministic).

## Public API/interfaces/types changes
- `ContainerDetails` in `packages/orchestrator/src/runtime.ts` adds:
  - `status: string` (Docker `State.Status`)
- `DockerodeRuntime.inspectContainer` in `packages/orchestrator/src/dockerode-runtime.ts` returns the new `status`.

No HTTP contract changes are required for this phase.

## Implementation steps

1. Update runtime inspect contract
- File: `packages/orchestrator/src/runtime.ts`
- Add `status` to `ContainerDetails`.

2. Populate Docker state in runtime adapter
- File: `packages/orchestrator/src/dockerode-runtime.ts`
- In `inspectContainer`, return:
  - `id`
  - `labels`
  - `status: details.State?.Status ?? 'unknown'`

3. Add reconciliation helpers in orchestrator
- File: `packages/orchestrator/src/orchestrator.ts`
- Add private helper methods:
  - `reconcileBoxForRead(box: Box): Promise<Box>`
  - `mapContainerStateToBoxStatus(containerStatus: string): Box['status']`
  - `updateBoxIfChanged(boxId: string, patch): Box`
- Implement read-path reconciliation:
  - `getBox`: fetch box, return null if missing/deleted, otherwise reconcile and return reconciled value.
  - `listBoxes`: fetch list, reconcile each box, return reconciled list.
- Reconciliation should:
  - no-op for `creating/stopping/removing`.
  - apply missing/unmanaged rules and state mapping above.

4. Preserve existing mutation behavior
- Keep existing create/stop/remove job flows as-is (including failure-to-`error` behavior already implemented).
- Reconciliation supplements these flows, not replaces them.

5. Add/adjust tests (high-ROI)
- File: `packages/orchestrator/test/orchestrator.test.ts`
- Add cases for:
  - box marked `running`, runtime reports `exited` -> read returns/stores `stopped`.
  - box marked `running`, runtime inspect 404 -> read returns/stores `error` and nulls `containerId`.
  - unmanaged labels on inspect -> read returns/stores `error`.
  - transitional `creating` box with exited container -> no reconciliation change during transition.
- Keep existing lifecycle failure tests intact.

6. API route regression safety
- File: `apps/api/test/routes.test.ts`
- Add one integration-style assertion:
  - create running box fixture in in-memory harness, mutate runtime to simulate exited container, call `GET /v1/boxes`, assert returned status is reconciled.

7. Documentation updates (required)
- File: `USAGE.md`
  - Add one concise user-flow note: box status in list/detail reflects reconciled Docker runtime state on reads.
- File: `ARCHITECTURE.md`
  - Add one concise architecture note under orchestrator/API components: read-path status reconciliation occurs in orchestrator before API responses.

8. Completion review step (required)
- Explicitly review whether further `USAGE.md` / `ARCHITECTURE.md` updates are needed after implementation.
- If no further changes are needed, note that in the PR summary/checklist.

## Functional changes after implementation
- `GET /v1/boxes` and `GET /v1/boxes/:boxId` will correct stale persisted status based on current Docker container state.
- Boxes that have exited after being marked `running` will be shown as `stopped` without requiring a separate user action.
- Missing/unmanaged container drift will be surfaced as `error` status on read.

## High-ROI tests
- Orchestrator unit: `running -> exited => stopped` reconciliation (core user-visible bug).
- Orchestrator unit: missing container (`inspect 404`) becomes `error` + `containerId=null` (common drift case).
- Orchestrator unit: transitional states are not overwritten by read-path reconciliation (race-risk guardrail).
- API route test: `/v1/boxes` returns reconciled status (ensures end-user path correctness).

## Risks and mitigations
- Risk: read-path writes can add DB churn.
  - Mitigation: write only when status/containerId actually changed.
- Risk: reconciliation might conflict with active jobs.
  - Mitigation: skip transitional states in phase 1.
- Risk: status mapping edge cases (`paused/restarting/created`).
  - Mitigation: map these to `running` in phase 1; revisit with richer status model in phase 2.

## Follow-up for Phase 2
- Add Docker event-driven reconciler and periodic sweep.
- Add startup recovery for in-flight jobs.
- Add network/volume existence reconciliation.
