import { describe, expect, it } from 'vitest';

import { OrchestratorEvents } from '../src/events.js';
import { JobRunner } from '../src/job-runner.js';
import { DevboxOrchestrator } from '../src/orchestrator.js';
import { ValidationError } from '../src/errors.js';
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

function buildHarness(): {
  runtime: MockDockerRuntime;
  orchestrator: DevboxOrchestrator;
  boxes: InMemoryBoxRepository;
} {
  const boxes = new InMemoryBoxRepository();
  const jobs = new InMemoryJobRepository();
  const events = new OrchestratorEvents();
  const runtime = new MockDockerRuntime();
  const runner = new JobRunner(jobs, events);
  const orchestrator = new DevboxOrchestrator(runtime, boxes, jobs, runner, events);
  return { runtime, orchestrator, boxes };
}

describe('DevboxOrchestrator', () => {
  it('runs create -> running state transition and creates managed resources', async () => {
    const { runtime, orchestrator } = buildHarness();

    const { box, job } = await orchestrator.createBox({
      name: 'box-alpha',
      image: 'debian:trixie-slim'
    });

    const status = await waitForJob(orchestrator, job.id);
    expect(status).toBe('succeeded');

    const saved = await orchestrator.getBox(box.id);
    expect(saved?.status).toBe('running');
    expect(saved?.containerId).toBeTruthy();
    expect(runtime.networks.has(saved!.networkName)).toBe(true);
    expect(runtime.volumes.has(saved!.volumeName)).toBe(true);
  });

  it('runs stop and remove transitions', async () => {
    const { orchestrator } = buildHarness();

    const created = await orchestrator.createBox({
      name: 'box-bravo',
      image: 'alpine:3.20'
    });
    await waitForJob(orchestrator, created.job.id);

    const stopJob = await orchestrator.stopBox(created.box.id);
    expect(await waitForJob(orchestrator, stopJob.id)).toBe('succeeded');

    const stopped = await orchestrator.getBox(created.box.id);
    expect(stopped?.status).toBe('stopped');

    const removeJob = await orchestrator.removeBox(created.box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('succeeded');

    const removed = await orchestrator.getBox(created.box.id);
    expect(removed?.deletedAt).toBeTruthy();
  });

  it('rejects invalid inputs and unmanaged resources', async () => {
    const { runtime, orchestrator } = buildHarness();

    await expect(
      orchestrator.createBox({
        name: 'Invalid Name',
        image: 'debian:trixie-slim'
      })
    ).rejects.toBeInstanceOf(ValidationError);

    const created = await orchestrator.createBox({
      name: 'box-charlie',
      image: 'debian:trixie-slim'
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

  it('marks box status as error when lifecycle jobs fail', async () => {
    const { runtime, orchestrator } = buildHarness();

    runtime.failOn.createNetwork = new Error('network create failed');
    const failedCreate = await orchestrator.createBox({
      name: 'box-delta',
      image: 'debian:trixie-slim'
    });
    expect(await waitForJob(orchestrator, failedCreate.job.id)).toBe('failed');
    expect((await orchestrator.getBox(failedCreate.box.id))?.status).toBe('error');

    delete runtime.failOn.createNetwork;
    const created = await orchestrator.createBox({
      name: 'box-echo',
      image: 'debian:trixie-slim'
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
    expect((await orchestrator.getBox(created.box.id))?.status).toBe('error');
  });

  it('reconciles running boxes to stopped when runtime reports exited', async () => {
    const { runtime, orchestrator } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-foxtrot',
      image: 'debian:trixie-slim'
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

  it('marks boxes as error and clears container id when inspect returns not found', async () => {
    const { runtime, orchestrator } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-golf',
      image: 'debian:trixie-slim'
    });
    await waitForJob(orchestrator, created.job.id);

    const initial = await orchestrator.getBox(created.box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }

    runtime.containers.delete(initial.containerId);
    const reconciled = await orchestrator.getBox(created.box.id);
    expect(reconciled?.status).toBe('error');
    expect(reconciled?.containerId).toBeNull();
  });

  it('marks boxes as error and preserves container id for unmanaged containers on reads', async () => {
    const { runtime, orchestrator } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-hotel',
      image: 'debian:trixie-slim'
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
      name: 'box-india',
      image: 'debian:trixie-slim'
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
      name: 'box-juliet',
      image: 'debian:trixie-slim'
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
      name: 'box-kilo',
      image: 'debian:trixie-slim'
    });
    await waitForJob(orchestrator, created.job.id);

    runtime.failOn.inspectContainer = new Error('runtime inspect unavailable');
    const box = await orchestrator.getBox(created.box.id);
    expect(box?.status).toBe('running');
  });

  it('does not emit box.updated events for read-path reconciliation writes', async () => {
    const { runtime, orchestrator } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-lima',
      image: 'debian:trixie-slim'
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
});
