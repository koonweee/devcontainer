import { describe, expect, it } from 'vitest';

import { OrchestratorEvents } from '../src/events.js';
import { JobRunner } from '../src/job-runner.js';
import { DevboxOrchestrator } from '../src/orchestrator.js';
import { ValidationError } from '../src/errors.js';
import { managedLabels } from '../src/runtime.js';
import { InMemoryBoxRepository, InMemoryJobRepository } from '../src/testing/in-memory-repositories.js';
import { MockDockerRuntime } from '../src/testing/mock-runtime.js';

async function waitForJob(
  orchestrator: DevboxOrchestrator,
  jobId: string
): Promise<'succeeded' | 'failed' | 'cancelled'> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const job = await orchestrator.getJob(jobId);
    if (!job) {
      throw new Error(`Job missing: ${jobId}`);
    }
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      return job.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function waitForCondition(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

function buildHarness(
  runtimeImage?: string,
  runtimeEnv: Record<string, string> = { DEV_PASSWORD: 'password' }
): {
  runtime: MockDockerRuntime;
  orchestrator: DevboxOrchestrator;
  boxes: InMemoryBoxRepository;
} {
  const boxes = new InMemoryBoxRepository();
  const jobs = new InMemoryJobRepository();
  const events = new OrchestratorEvents();
  const runtime = new MockDockerRuntime();
  const runner = new JobRunner(jobs, events);
  const orchestrator = new DevboxOrchestrator(
    runtime,
    boxes,
    jobs,
    runner,
    events,
    runtimeImage,
    runtimeEnv
  );
  return { runtime, orchestrator, boxes };
}

describe('DevboxOrchestrator', () => {
  it('runs create -> running state transition and creates managed resources', async () => {
    const { runtime, orchestrator, boxes } = buildHarness();

    const { box, job } = await orchestrator.createBox({
      name: 'box-alpha'
    });

    const status = await waitForJob(orchestrator, job.id);
    expect(status).toBe('succeeded');

    const saved = await orchestrator.getBox(box.id);
    expect(saved?.status).toBe('running');
    expect(saved?.containerId).toBeTruthy();
    expect(runtime.networks.has(saved!.networkName)).toBe(true);
    expect(runtime.volumes.has(saved!.volumeName)).toBe(true);
  });

  it('uses configured runtime image when creating boxes', async () => {
    const { runtime, orchestrator } = buildHarness('runtime:test');
    const { box, job } = await orchestrator.createBox({ name: 'runtime-image-box' });
    expect(await waitForJob(orchestrator, job.id)).toBe('succeeded');
    expect(box.image).toBe('runtime:test');
    expect(runtime.lastCreateContainerOptions?.env?.DEV_PASSWORD).toBe('password');
  });

  it('lets runtime env override request env keys', async () => {
    const { runtime, orchestrator } = buildHarness('runtime:test', {
      DEV_PASSWORD: 'configured-password',
      TZ: 'UTC'
    });
    const created = await orchestrator.createBox({
      name: 'runtime-env-box',
      env: {
        DEV_PASSWORD: 'request-password',
        EXTRA: 'value'
      }
    });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');
    expect(runtime.lastCreateContainerOptions?.env).toEqual({
      DEV_PASSWORD: 'configured-password',
      TZ: 'UTC',
      EXTRA: 'value'
    });
  });

  it('runs stop and remove transitions', async () => {
    const { orchestrator, runtime } = buildHarness();

    const created = await orchestrator.createBox({
      name: 'box-bravo'
    });
    await waitForJob(orchestrator, created.job.id);

    const stopJob = await orchestrator.stopBox(created.box.id);
    expect(await waitForJob(orchestrator, stopJob.id)).toBe('succeeded');

    const stopped = await orchestrator.getBox(created.box.id);
    expect(stopped?.status).toBe('stopped');

    let removedEventBoxId: string | null = null;
    const unsubscribe = orchestrator.events.subscribe((event) => {
      if (event.type === 'box.removed') {
        removedEventBoxId = event.boxId;
      }
    });

    const removeJob = await orchestrator.removeBox(created.box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('succeeded');
    unsubscribe();

    const removed = await orchestrator.getBox(created.box.id);
    expect(removed).toBeNull();
    expect(removedEventBoxId).toBe(created.box.id);
    expect(runtime.operations.findIndex((entry) => entry.startsWith('stopContainer:'))).toBeLessThan(
      runtime.operations.findIndex((entry) => entry.startsWith('removeContainer:'))
    );
  });

  it('runs start transition from stopped to running', async () => {
    const { orchestrator } = buildHarness();

    const created = await orchestrator.createBox({
      name: 'box-start'
    });
    await waitForJob(orchestrator, created.job.id);

    const stopJob = await orchestrator.stopBox(created.box.id);
    expect(await waitForJob(orchestrator, stopJob.id)).toBe('succeeded');

    const startJob = await orchestrator.startBox(created.box.id);
    expect(startJob.type).toBe('start');
    expect(await waitForJob(orchestrator, startJob.id)).toBe('succeeded');
    expect((await orchestrator.getBox(created.box.id))?.status).toBe('running');
  });

  it('rejects start when box is not stopped', async () => {
    const { orchestrator } = buildHarness();

    const created = await orchestrator.createBox({
      name: 'box-start-invalid'
    });
    await waitForJob(orchestrator, created.job.id);

    await expect(orchestrator.startBox(created.box.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it('stops before remove when deleting running boxes', async () => {
    const { orchestrator, runtime } = buildHarness();

    const created = await orchestrator.createBox({
      name: 'box-remove-order'
    });
    await waitForJob(orchestrator, created.job.id);

    const removeJob = await orchestrator.removeBox(created.box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('succeeded');

    const stopIndex = runtime.operations.findIndex((entry) => entry.startsWith('stopContainer:'));
    const removeIndex = runtime.operations.findIndex((entry) => entry.startsWith('removeContainer:'));
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeGreaterThan(stopIndex);
  });

  it('fails remove and keeps box when stop during remove fails', async () => {
    const { runtime, orchestrator } = buildHarness();

    const created = await orchestrator.createBox({
      name: 'box-remove-stop-fail'
    });
    await waitForJob(orchestrator, created.job.id);

    runtime.failOn.stopContainer = new Error('stop failed during remove');
    const removeJob = await orchestrator.removeBox(created.box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('failed');
    expect((await orchestrator.getBox(created.box.id))?.status).toBe('error');
  });

  it('rejects invalid inputs and unmanaged resources', async () => {
    const { runtime, orchestrator } = buildHarness();

    await expect(
      orchestrator.createBox({
        name: 'Invalid Name'
      })
    ).rejects.toBeInstanceOf(ValidationError);

    const created = await orchestrator.createBox({
      name: 'box-charlie'
    });
    await waitForJob(orchestrator, created.job.id);

    const box = await orchestrator.getBox(created.box.id);
    if (!box?.containerId) {
      throw new Error('Expected container id');
    }

    const container = runtime.containers.get(box.containerId);
    if (!container) {
      throw new Error('Expected container in mock runtime');
    }
    container.labels = {};

    const stopJob = await orchestrator.stopBox(created.box.id);
    expect(await waitForJob(orchestrator, stopJob.id)).toBe('failed');
    const errored = await orchestrator.getBox(created.box.id);
    expect(errored?.status).toBe('error');
  });

  it('marks box status as error when create/stop jobs fail and hard deletes after missing-container remove failures', async () => {
    const { runtime, orchestrator } = buildHarness();

    runtime.failOn.createNetwork = new Error('network create failed');
    const failedCreate = await orchestrator.createBox({
      name: 'box-delta'
    });
    expect(await waitForJob(orchestrator, failedCreate.job.id)).toBe('failed');
    expect((await orchestrator.getBox(failedCreate.box.id))?.status).toBe('error');

    delete runtime.failOn.createNetwork;
    const created = await orchestrator.createBox({
      name: 'box-echo'
    });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    runtime.failOn.stopContainer = new Error('stop failed');
    const stopJob = await orchestrator.stopBox(created.box.id);
    expect(await waitForJob(orchestrator, stopJob.id)).toBe('failed');
    expect((await orchestrator.getBox(created.box.id))?.status).toBe('error');

    delete runtime.failOn.stopContainer;
    runtime.failOn.removeVolume = new Error('remove volume failed');
    const removeJob = await orchestrator.removeBox(created.box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('failed');
    expect(await orchestrator.getBox(created.box.id)).toBeNull();
  });

  it('reconciles running boxes to stopped when runtime reports exited', async () => {
    const { runtime, orchestrator } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-foxtrot'
    });
    await waitForJob(orchestrator, created.job.id);

    const initial = await orchestrator.getBox(created.box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }

    runtime.setContainerStatus(initial.containerId, 'exited');
    const reconciled = await orchestrator.getBox(created.box.id);
    expect(reconciled?.status).toBe('stopped');

    const persisted = await orchestrator.getBox(created.box.id);
    expect(persisted?.status).toBe('stopped');
  });

  it('hard deletes boxes when inspect returns not found', async () => {
    const { runtime, orchestrator } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-golf'
    });
    await waitForJob(orchestrator, created.job.id);

    const initial = await orchestrator.getBox(created.box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }

    runtime.containers.delete(initial.containerId);
    const reconciled = await orchestrator.getBox(created.box.id);
    expect(reconciled).toBeNull();
  });

  it('marks boxes as error and preserves container id for unmanaged containers on reads', async () => {
    const { runtime, orchestrator } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-hotel'
    });
    await waitForJob(orchestrator, created.job.id);

    const initial = await orchestrator.getBox(created.box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }

    const container = runtime.containers.get(initial.containerId);
    if (!container) {
      throw new Error('Expected container record');
    }
    container.labels = {};

    const reconciled = await orchestrator.getBox(created.box.id);
    expect(reconciled?.status).toBe('error');
    expect(reconciled?.containerId).toBe(initial.containerId);
  });

  it('skips reconciliation for transitional statuses', async () => {
    const { runtime, orchestrator, boxes } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-india'
    });
    await waitForJob(orchestrator, created.job.id);

    const initial = await orchestrator.getBox(created.box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }

    boxes.update(created.box.id, { status: 'creating' });
    runtime.setContainerStatus(initial.containerId, 'exited');

    const reconciled = await orchestrator.getBox(created.box.id);
    expect(reconciled?.status).toBe('creating');
  });

  it('marks stable boxes without container id as error', async () => {
    const { orchestrator, boxes } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-juliet'
    });
    await waitForJob(orchestrator, created.job.id);

    boxes.update(created.box.id, {
      status: 'running',
      containerId: null
    });

    const reconciled = await orchestrator.getBox(created.box.id);
    expect(reconciled?.status).toBe('error');
    expect(reconciled?.containerId).toBeNull();
  });

  it('keeps persisted state when inspect fails with non-404 runtime errors', async () => {
    const { runtime, orchestrator } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-kilo'
    });
    await waitForJob(orchestrator, created.job.id);

    runtime.failOn.inspectContainer = new Error('runtime inspect unavailable');
    const box = await orchestrator.getBox(created.box.id);
    expect(box?.status).toBe('running');
  });

  it('does not emit box.updated events for read-path reconciliation writes', async () => {
    const { runtime, orchestrator } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-lima'
    });
    await waitForJob(orchestrator, created.job.id);

    const initial = await orchestrator.getBox(created.box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }
    runtime.setContainerStatus(initial.containerId, 'exited');

    let boxUpdatedEvents = 0;
    const unsubscribe = orchestrator.events.subscribe((event) => {
      if (event.type === 'box.updated') {
        boxUpdatedEvents += 1;
      }
    });

    const reconciled = await orchestrator.getBox(created.box.id);
    unsubscribe();

    expect(reconciled?.status).toBe('stopped');
    expect(boxUpdatedEvents).toBe(0);
  });

  it('updates running boxes on external runtime events and emits box.updated once', async () => {
    const { runtime, orchestrator, boxes } = buildHarness();
    const created = await orchestrator.createBox({ name: 'box-mike' });
    await waitForJob(orchestrator, created.job.id);

    const initial = await orchestrator.getBox(created.box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }

    await orchestrator.startRuntimeStatusMonitor();

    let boxUpdatedEvents = 0;
    const unsubscribe = orchestrator.events.subscribe((event) => {
      if (event.type === 'box.updated') {
        boxUpdatedEvents += 1;
      }
    });

    runtime.setContainerStatus(initial.containerId, 'exited');
    runtime.emitContainerEvent({
      containerId: initial.containerId,
      action: 'die',
      labels: managedLabels(created.box.id),
      timestamp: new Date().toISOString()
    });

    await waitForCondition(() => boxes.get(created.box.id)?.status === 'stopped');

    unsubscribe();
    await orchestrator.stopRuntimeStatusMonitor();

    expect(boxUpdatedEvents).toBe(1);
  });

  it('does not emit duplicate updates when runtime event does not change status', async () => {
    const { runtime, orchestrator, boxes } = buildHarness();
    const created = await orchestrator.createBox({ name: 'box-november' });
    await waitForJob(orchestrator, created.job.id);

    const initial = await orchestrator.getBox(created.box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }

    await orchestrator.startRuntimeStatusMonitor();

    let boxUpdatedEvents = 0;
    const unsubscribe = orchestrator.events.subscribe((event) => {
      if (event.type === 'box.updated') {
        boxUpdatedEvents += 1;
      }
    });

    runtime.emitContainerEvent({
      containerId: initial.containerId,
      action: 'start',
      labels: managedLabels(created.box.id),
      timestamp: new Date().toISOString()
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    unsubscribe();
    await orchestrator.stopRuntimeStatusMonitor();

    expect((await orchestrator.getBox(created.box.id))?.status).toBe('running');
    expect(boxUpdatedEvents).toBe(0);
  });

  it('reconnects runtime monitor after stream failures and resumes reconciliation', async () => {
    const { runtime, orchestrator, boxes } = buildHarness();
    const created = await orchestrator.createBox({ name: 'box-oscar' });
    await waitForJob(orchestrator, created.job.id);

    const initial = await orchestrator.getBox(created.box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }

    runtime.failOn.streamContainerEvents = new Error('stream unavailable');
    await orchestrator.startRuntimeStatusMonitor();

    runtime.setContainerStatus(initial.containerId, 'exited');
    runtime.emitContainerEvent({
      containerId: initial.containerId,
      action: 'die',
      labels: managedLabels(created.box.id),
      timestamp: new Date().toISOString()
    });

    await waitForCondition(() => boxes.get(created.box.id)?.status === 'stopped', 5_000);
    await orchestrator.stopRuntimeStatusMonitor();
  });

  it('does not override transitional statuses from runtime monitor events', async () => {
    const { runtime, orchestrator, boxes } = buildHarness();
    const created = await orchestrator.createBox({ name: 'box-papa' });
    await waitForJob(orchestrator, created.job.id);

    const initial = await orchestrator.getBox(created.box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }

    boxes.update(created.box.id, { status: 'creating' });
    await orchestrator.startRuntimeStatusMonitor();

    runtime.setContainerStatus(initial.containerId, 'exited');
    runtime.emitContainerEvent({
      containerId: initial.containerId,
      action: 'die',
      labels: managedLabels(created.box.id),
      timestamp: new Date().toISOString()
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stopRuntimeStatusMonitor();

    expect((await orchestrator.getBox(created.box.id))?.status).toBe('creating');
  });

  it('auto-recovers errored boxes to running on external start events', async () => {
    const { runtime, orchestrator, boxes } = buildHarness();
    const created = await orchestrator.createBox({ name: 'box-recover-start' });
    await waitForJob(orchestrator, created.job.id);

    runtime.failOn.stopContainer = new Error('forced stop failure');
    const stopJob = await orchestrator.stopBox(created.box.id);
    expect(await waitForJob(orchestrator, stopJob.id)).toBe('failed');
    delete runtime.failOn.stopContainer;

    const before = await orchestrator.getBox(created.box.id);
    if (!before?.containerId) {
      throw new Error('Expected container id for recovery test');
    }
    expect(before.status).toBe('error');

    await orchestrator.startRuntimeStatusMonitor();
    runtime.setContainerStatus(before.containerId, 'running');
    runtime.emitContainerEvent({
      containerId: before.containerId,
      action: 'start',
      labels: managedLabels(created.box.id),
      timestamp: new Date().toISOString()
    });

    await waitForCondition(() => boxes.get(created.box.id)?.status === 'running');
    await orchestrator.stopRuntimeStatusMonitor();
  });

  it('hard deletes boxes on external destroy events and emits box.removed', async () => {
    const { runtime, orchestrator, boxes } = buildHarness();
    const created = await orchestrator.createBox({ name: 'box-quebec' });
    await waitForJob(orchestrator, created.job.id);

    const initial = await orchestrator.getBox(created.box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }

    await orchestrator.startRuntimeStatusMonitor();
    let removedEvents = 0;
    const unsubscribe = orchestrator.events.subscribe((event) => {
      if (event.type === 'box.removed' && event.boxId === created.box.id) {
        removedEvents += 1;
      }
    });

    runtime.containers.delete(initial.containerId);
    runtime.emitContainerEvent({
      containerId: initial.containerId,
      action: 'destroy',
      labels: managedLabels(created.box.id),
      timestamp: new Date().toISOString()
    });

    await waitForCondition(() => boxes.get(created.box.id) === null);

    unsubscribe();
    await orchestrator.stopRuntimeStatusMonitor();
    expect(removedEvents).toBe(1);
  });
});
