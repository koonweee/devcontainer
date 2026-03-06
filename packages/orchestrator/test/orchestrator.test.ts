import { describe, expect, it, vi } from 'vitest';

import { OrchestratorEvents } from '../src/events.js';
import { JobRunner } from '../src/job-runner.js';
import { DevboxOrchestrator } from '../src/orchestrator.js';
import { SetupRequiredError, ValidationError } from '../src/errors.js';
import { managedLabels } from '../src/runtime.js';
import { InMemoryBoxRepository, InMemoryJobRepository, InMemoryTailnetConfigRepository } from '../src/testing/in-memory-repositories.js';
import { MockDockerRuntime } from '../src/testing/mock-runtime.js';
import { MockTailscaleClient } from '../src/testing/mock-tailscale-client.js';

async function waitForJob(
  orchestrator: DevboxOrchestrator,
  jobId: string
): Promise<'succeeded' | 'failed' | 'cancelled'> {
  const deadline = Date.now() + 5000;
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
  runtimeImage = 'runtime:test',
  runtimeEnv: Record<string, string> = {}
): {
  runtime: MockDockerRuntime;
  orchestrator: DevboxOrchestrator;
  boxes: InMemoryBoxRepository;
  tailnetConfig: InMemoryTailnetConfigRepository;
  tailscaleClient: MockTailscaleClient;
} {
  const boxes = new InMemoryBoxRepository();
  const jobs = new InMemoryJobRepository();
  const events = new OrchestratorEvents();
  const runtime = new MockDockerRuntime();
  const runner = new JobRunner(jobs, events);
  const tailnetConfig = new InMemoryTailnetConfigRepository();
  const tailscaleClient = new MockTailscaleClient();
  tailnetConfig.set({
    tailnet: 'example.com',
    oauthClientId: 'client-id',
    oauthClientSecret: 'client-secret'
  });
  const orchestrator = new DevboxOrchestrator(
    runtime,
    boxes,
    jobs,
    runner,
    events,
    runtimeImage,
    runtimeEnv,
    tailnetConfig,
    tailscaleClient,
    [1, 1, 1]
  );
  return { runtime, orchestrator, boxes, tailnetConfig, tailscaleClient };
}

describe('DevboxOrchestrator', () => {
  it('creates one managed workspace container with tailscale privileges', async () => {
    const { runtime, orchestrator, boxes } = buildHarness('runtime:test', { TZ: 'UTC' });

    const created = await orchestrator.createBox({
      name: 'box-alpha',
      env: { EXTRA: 'value' },
      command: ['sleep', 'infinity']
    });

    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    expect(saved?.status).toBe('running');
    expect(saved?.containerId).toBeTruthy();
    expect(runtime.networks.has(saved!.networkName)).toBe(true);
    expect(runtime.volumes.has(saved!.volumeName)).toBe(true);
    expect(runtime.containers.size).toBe(1);

    const container = runtime.containers.get(saved!.containerId!);
    expect(container?.options.image).toBe('runtime:test');
    expect(container?.options.networkMode).toBe(saved!.networkName);
    expect(container?.options.mounts).toEqual([
      {
        Type: 'volume',
        Source: saved!.volumeName,
        Target: '/workspace'
      }
    ]);
    expect(container?.options.devices).toEqual([
      {
        PathOnHost: '/dev/net/tun',
        PathInContainer: '/dev/net/tun',
        CgroupPermissions: 'rwm'
      }
    ]);
    expect(container?.options.capAdd).toEqual(['NET_ADMIN', 'NET_RAW']);
    expect(container?.options.env).toMatchObject({
      EXTRA: 'value',
      TZ: 'UTC',
      DEVBOX_TAILSCALE_AUTHKEY: 'tskey-auth-mock',
      DEVBOX_TAILSCALE_HOSTNAME: expect.stringContaining('devbox-box-alpha-')
    });
    expect(container?.labels).toEqual(
      managedLabels({
        boxId: created.box.id,
        kind: 'container'
      })
    );
    expect(saved?.tailnetUrl).toContain('ssh://');
  });

  it('requires tailnet setup before creating boxes', async () => {
    const boxes = new InMemoryBoxRepository();
    const jobs = new InMemoryJobRepository();
    const events = new OrchestratorEvents();
    const runtime = new MockDockerRuntime();
    const runner = new JobRunner(jobs, events);
    const tailnetConfig = new InMemoryTailnetConfigRepository();
    const tailscaleClient = new MockTailscaleClient();
    const orchestrator = new DevboxOrchestrator(
      runtime,
      boxes,
      jobs,
      runner,
      events,
      'runtime:test',
      {},
      tailnetConfig,
      tailscaleClient
    );

    await expect(orchestrator.createBox({ name: 'no-setup' })).rejects.toBeInstanceOf(SetupRequiredError);
  });

  it('fails create when the workspace never registers a tailscale device', async () => {
    const { orchestrator, boxes, runtime, tailscaleClient } = buildHarness();
    tailscaleClient.autoCreateDeviceOnLookup = false;

    const created = await orchestrator.createBox({ name: 'box-no-device' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('failed');
    expect(boxes.get(created.box.id)).toBeNull();
    expect(runtime.containers.size).toBe(0);
    expect(runtime.networks.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
  });

  it('stops then removes the single runtime container and its resources', async () => {
    const { orchestrator, runtime, boxes, tailscaleClient } = buildHarness();

    const created = await orchestrator.createBox({ name: 'box-remove' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.containerId || !saved.tailnetDeviceId) {
      throw new Error('Expected container and tailnet device ids');
    }

    const stopJob = await orchestrator.stopBox(created.box.id);
    expect(await waitForJob(orchestrator, stopJob.id)).toBe('succeeded');

    runtime.operations.length = 0;
    const removeJob = await orchestrator.removeBox(created.box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('succeeded');
    expect(boxes.get(created.box.id)).toBeNull();

    expect(runtime.operations).toEqual([
      `stopContainer:${saved.containerId}`,
      `removeContainer:${saved.containerId}`,
      `removeNetwork:${saved.networkName}`,
      `removeVolume:${saved.volumeName}`
    ]);

    const deleteCall = tailscaleClient.calls.find((call) => call.method === 'deleteDevice');
    expect(deleteCall?.args[1]).toBe(saved.tailnetDeviceId);
  });

  it('streams logs from the managed workspace container', async () => {
    const { orchestrator, runtime, boxes } = buildHarness();

    const created = await orchestrator.createBox({ name: 'box-logs' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.containerId) {
      throw new Error('Expected container id');
    }

    runtime.pushLog(saved.containerId, {
      stream: 'stdout',
      line: 'hello',
      timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString()
    });

    const logs = await orchestrator.streamBoxLogs(created.box.id, {});
    const received = [];
    for await (const item of logs) {
      received.push(item);
    }

    expect(received).toEqual([
      {
        boxId: created.box.id,
        stream: 'stdout',
        line: 'hello',
        timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString()
      }
    ]);
    expect(runtime.lastStreamContainerLogsContainerId).toBe(saved.containerId);
  });

  it('rejects log access if the stored container loses managed labels', async () => {
    const { orchestrator, runtime, boxes } = buildHarness();

    const created = await orchestrator.createBox({ name: 'box-unmanaged' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.containerId) {
      throw new Error('Expected container id');
    }

    const container = runtime.containers.get(saved.containerId);
    if (!container) {
      throw new Error('Expected container in mock runtime');
    }
    container.labels = {};

    await expect(orchestrator.streamBoxLogs(created.box.id, {})).rejects.toMatchObject({
      name: 'SecurityError'
    });
  });

  it('reconciles stopped status from single-container runtime state', async () => {
    const { orchestrator, runtime, boxes } = buildHarness();

    const created = await orchestrator.createBox({ name: 'box-reconcile' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.containerId) {
      throw new Error('Expected container id');
    }

    runtime.setContainerStatus(saved.containerId, 'exited');

    const reconciled = await orchestrator.getBox(created.box.id);
    expect(reconciled?.status).toBe('stopped');
  });

  it('enqueues cleanup when the managed container is externally deleted', async () => {
    const { orchestrator, runtime, boxes } = buildHarness();

    const created = await orchestrator.createBox({ name: 'box-cleanup' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.containerId) {
      throw new Error('Expected container id');
    }

    runtime.containers.delete(saved.containerId);
    runtime.emitContainerEvent({
      containerId: saved.containerId,
      action: 'destroy',
      labels: managedLabels({ boxId: saved.id, kind: 'container' }),
      timestamp: new Date().toISOString()
    });

    await orchestrator.startRuntimeStatusMonitor();
    await waitForCondition(() => boxes.get(created.box.id) === null, 4_000);
    await orchestrator.stopRuntimeStatusMonitor();
  });

  it('runs cleanup after failed remove when stop fails', async () => {
    const { runtime, orchestrator } = buildHarness();

    const created = await orchestrator.createBox({ name: 'box-remove-stop-fail' });
    await waitForJob(orchestrator, created.job.id);

    runtime.failOn.stopContainer = new Error('stop failed during remove');
    const removeJob = await orchestrator.removeBox(created.box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('failed');
    delete runtime.failOn.stopContainer;
    await waitForCondition(async () => (await orchestrator.getBox(created.box.id)) === null);
  });

  it('rejects invalid inputs and unmanaged stop operations', async () => {
    const { runtime, orchestrator } = buildHarness();

    await expect(
      orchestrator.createBox({
        name: 'Invalid Name'
      })
    ).rejects.toBeInstanceOf(ValidationError);

    const created = await orchestrator.createBox({ name: 'box-charlie' });
    await waitForJob(orchestrator, created.job.id);

    const box = await orchestrator.getBox(created.box.id);
    if (!box) {
      throw new Error('Expected public box');
    }
    const internal = runtime.lastCreateContainerOptions;
    expect(internal?.name).toContain(created.box.id);

    const savedContainerId = runtime.containers.keys().next().value as string | undefined;
    if (!savedContainerId) {
      throw new Error('Expected container');
    }

    const container = runtime.containers.get(savedContainerId);
    if (!container) {
      throw new Error('Expected container in mock runtime');
    }
    container.labels = {};

    const stopJob = await orchestrator.stopBox(created.box.id);
    expect(await waitForJob(orchestrator, stopJob.id)).toBe('failed');
    const errored = await orchestrator.getBox(created.box.id);
    expect(errored?.status).toBe('error');
  });

  it('verifies tailscale registration again on start', async () => {
    const { orchestrator, boxes } = buildHarness();

    const created = await orchestrator.createBox({ name: 'box-restart' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const stopJob = await orchestrator.stopBox(created.box.id);
    expect(await waitForJob(orchestrator, stopJob.id)).toBe('succeeded');

    const beforeStart = boxes.get(created.box.id);
    if (!beforeStart?.tailnetDeviceId) {
      throw new Error('Expected stored device id');
    }

    const startJob = await orchestrator.startBox(created.box.id);
    expect(await waitForJob(orchestrator, startJob.id)).toBe('succeeded');

    const restarted = boxes.get(created.box.id);
    expect(restarted?.status).toBe('running');
    expect(restarted?.tailnetDeviceId).toBeTruthy();
  });

  it('keeps runtime env precedence over request env when injecting container env', async () => {
    const { runtime, orchestrator } = buildHarness('runtime:test', {
      TZ: 'UTC',
      EXTRA: 'runtime'
    });

    const created = await orchestrator.createBox({
      name: 'runtime-env-box',
      env: {
        EXTRA: 'request'
      }
    });

    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');
    expect(runtime.lastCreateContainerOptions?.env).toMatchObject({
      TZ: 'UTC',
      EXTRA: 'runtime'
    });
  });

  it('marks a box error if runtime inspect returns unmanaged labels during reconcile', async () => {
    const { orchestrator, runtime, boxes } = buildHarness();
    const created = await orchestrator.createBox({ name: 'box-reconcile-error' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.containerId) {
      throw new Error('Expected container id');
    }

    const container = runtime.containers.get(saved.containerId);
    if (!container) {
      throw new Error('Expected container');
    }
    container.labels = {};

    const reconciled = await orchestrator.getBox(created.box.id);
    expect(reconciled?.status).toBe('error');
  });

  it('emits a warning-only path when tailnet delete fails during removal', async () => {
    const { orchestrator, tailscaleClient } = buildHarness();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const created = await orchestrator.createBox({ name: 'box-tailnet-delete-warn' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    tailscaleClient.failOn.deleteDevice = new Error('boom');
    const removeJob = await orchestrator.removeBox(created.box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('succeeded');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tailnet cleanup failed for box'));
    warnSpy.mockRestore();
  });
});
