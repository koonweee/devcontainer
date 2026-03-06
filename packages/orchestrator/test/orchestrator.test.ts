import { describe, expect, it, vi } from 'vitest';

import { OrchestratorEvents } from '../src/events.js';
import { JobRunner } from '../src/job-runner.js';
import { DevboxOrchestrator } from '../src/orchestrator.js';
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

function buildTailnetHarness(): {
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
    'runtime:test',
    { TZ: 'UTC' },
    tailnetConfig,
    tailscaleClient,
    'sidecar:test',
    [1, 1, 1]
  );
  return { runtime, orchestrator, boxes, tailnetConfig, tailscaleClient };
}

describe('DevboxOrchestrator', () => {
  it('creates grouped workspace and tailscale resources with expected privileges', async () => {
    const { runtime, orchestrator, boxes } = buildTailnetHarness();

    const created = await orchestrator.createBox({
      name: 'box-alpha',
      env: { EXTRA: 'value' },
      command: ['sleep', 'infinity']
    });

    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    expect(saved?.status).toBe('running');
    expect(saved?.workspaceContainerId).toBeTruthy();
    expect(saved?.tailscaleContainerId).toBeTruthy();
    expect(runtime.networks.has(saved!.networkName)).toBe(true);
    expect(runtime.volumes.has(saved!.workspaceVolumeName)).toBe(true);
    expect(runtime.volumes.has(saved!.tailscaleStateVolumeName)).toBe(true);
    expect(runtime.containers.size).toBe(2);

    const createdContainers = [...runtime.containers.values()];
    const workspace = createdContainers.find(
      (container) => container.labels['com.devbox.role'] === 'workspace'
    );
    const tailscale = createdContainers.find(
      (container) => container.labels['com.devbox.role'] === 'tailscale'
    );

    expect(workspace?.options.image).toBe('runtime:test');
    expect(workspace?.options.networkMode).toBe(`container:devbox-tailscale-${created.box.id}`);
    expect(workspace?.options.mounts).toEqual([
      {
        Type: 'volume',
        Source: saved!.workspaceVolumeName,
        Target: '/workspace'
      }
    ]);
    expect(workspace?.options.capDrop).toEqual(['NET_RAW']);
    expect(workspace?.options.env).toEqual({ EXTRA: 'value', TZ: 'UTC' });
    expect(workspace?.options.devices).toBeUndefined();
    expect(workspace?.options.capAdd).toBeUndefined();
    expect(workspace?.labels).toEqual(
      managedLabels({
        boxId: created.box.id,
        group: `devbox-${created.box.id}`,
        role: 'workspace',
        kind: 'container'
      })
    );

    expect(tailscale?.options.image).toBe('sidecar:test');
    expect(tailscale?.options.networkMode).toBe(saved!.networkName);
    expect(tailscale?.options.mounts).toEqual([
      {
        Type: 'volume',
        Source: saved!.tailscaleStateVolumeName,
        Target: '/var/lib/tailscale'
      }
    ]);
    expect(tailscale?.options.capAdd).toEqual(['NET_ADMIN', 'NET_RAW']);
    expect(tailscale?.options.devices).toEqual([
      {
        PathOnHost: '/dev/net/tun',
        PathInContainer: '/dev/net/tun',
        CgroupPermissions: 'rwm'
      }
    ]);
    expect(tailscale?.options.env).toMatchObject({
      DEVBOX_TAILSCALE_AUTHKEY: 'tskey-auth-mock',
      DEVBOX_TAILSCALE_HOSTNAME: expect.stringContaining('devbox-box-alpha-')
    });
    expect(saved?.tailnetUrl).toContain('ssh://');
  });

  it('fails create when the sidecar never registers a tailscale device', async () => {
    const { orchestrator, boxes, runtime, tailscaleClient } = buildTailnetHarness();
    tailscaleClient.autoCreateDeviceOnLookup = false;

    const created = await orchestrator.createBox({ name: 'box-no-device' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('failed');
    expect(boxes.get(created.box.id)).toBeNull();
    expect(runtime.containers.size).toBe(0);
    expect(runtime.networks.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
  });

  it('stops workspace before sidecar and removes the full resource group', async () => {
    const { orchestrator, runtime, boxes, tailscaleClient } = buildTailnetHarness();

    const created = await orchestrator.createBox({ name: 'box-remove' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.workspaceContainerId || !saved.tailscaleContainerId || !saved.tailnetDeviceId) {
      throw new Error('Expected grouped resource ids');
    }

    const stopJob = await orchestrator.stopBox(created.box.id);
    expect(await waitForJob(orchestrator, stopJob.id)).toBe('succeeded');

    const stopWorkspaceIndex = runtime.operations.indexOf(`stopContainer:${saved.workspaceContainerId}`);
    const stopTailscaleIndex = runtime.operations.indexOf(`stopContainer:${saved.tailscaleContainerId}`);
    expect(stopWorkspaceIndex).toBeGreaterThanOrEqual(0);
    expect(stopTailscaleIndex).toBeGreaterThan(stopWorkspaceIndex);

    runtime.operations.length = 0;
    const removeJob = await orchestrator.removeBox(created.box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('succeeded');
    expect(boxes.get(created.box.id)).toBeNull();

    expect(runtime.operations).toEqual([
      `stopContainer:${saved.workspaceContainerId}`,
      `removeContainer:${saved.workspaceContainerId}`,
      `stopContainer:${saved.tailscaleContainerId}`,
      `removeContainer:${saved.tailscaleContainerId}`,
      `removeNetwork:${saved.networkName}`,
      `removeVolume:${saved.workspaceVolumeName}`,
      `removeVolume:${saved.tailscaleStateVolumeName}`
    ]);

    const deleteCall = tailscaleClient.calls.find((call) => call.method === 'deleteDevice');
    expect(deleteCall?.args[1]).toBe(saved.tailnetDeviceId);
  });

  it('streams logs from the workspace container only', async () => {
    const { orchestrator, runtime, boxes } = buildTailnetHarness();

    const created = await orchestrator.createBox({ name: 'box-logs' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.workspaceContainerId) {
      throw new Error('Expected workspace container id');
    }

    runtime.pushLog(saved.workspaceContainerId, {
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
    expect(runtime.lastStreamContainerLogsContainerId).toBe(saved.workspaceContainerId);
  });

  it('rejects log access if the stored workspace container loses its role labels', async () => {
    const { orchestrator, runtime, boxes } = buildTailnetHarness();

    const created = await orchestrator.createBox({ name: 'box-unmanaged' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.workspaceContainerId) {
      throw new Error('Expected workspace container id');
    }

    const container = runtime.containers.get(saved.workspaceContainerId);
    if (!container) {
      throw new Error('Expected workspace container in mock runtime');
    }
    container.labels = {};

    await expect(orchestrator.streamBoxLogs(created.box.id, {})).rejects.toMatchObject({
      name: 'SecurityError'
    });
  });

  it('marks a box error when only one grouped container is running', async () => {
    const { orchestrator, runtime, boxes } = buildTailnetHarness();

    const created = await orchestrator.createBox({ name: 'box-split-state' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.workspaceContainerId || !saved.tailscaleContainerId) {
      throw new Error('Expected grouped resource ids');
    }

    runtime.setContainerStatus(saved.workspaceContainerId, 'running');
    runtime.setContainerStatus(saved.tailscaleContainerId, 'exited');

    const reconciled = await orchestrator.getBox(created.box.id);
    expect(reconciled?.status).toBe('error');
  });

  it('enqueues cleanup if either grouped container disappears externally', async () => {
    const { orchestrator, runtime, boxes } = buildTailnetHarness();
    await orchestrator.startRuntimeStatusMonitor();

    const created = await orchestrator.createBox({ name: 'box-external-delete' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.workspaceContainerId) {
      throw new Error('Expected workspace container id');
    }

    runtime.containers.delete(saved.workspaceContainerId);
    runtime.emitContainerEvent({
      containerId: saved.workspaceContainerId,
      action: 'destroy',
      labels: managedLabels({
        boxId: saved.id,
        group: `devbox-${saved.id}`,
        role: 'workspace',
        kind: 'container'
      }),
      timestamp: new Date().toISOString()
    });

    await waitForCondition(() => boxes.get(created.box.id) === null, 5_000);
    await orchestrator.stopRuntimeStatusMonitor();
  });

  it('falls back to hostname cleanup when device id is missing', async () => {
    const { orchestrator, boxes, tailscaleClient } = buildTailnetHarness();

    const created = await orchestrator.createBox({ name: 'box-fallback-cleanup' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.tailnetDeviceId || !saved.tailnetUrl) {
      throw new Error('Expected tailnet device state');
    }

    tailscaleClient.devices = [
      {
        id: saved.tailnetDeviceId,
        hostname: saved.tailnetUrl.slice('ssh://'.length),
        name: saved.tailnetUrl.slice('ssh://'.length)
      }
    ];
    boxes.update(saved.id, { tailnetDeviceId: null });

    const removeJob = await orchestrator.removeBox(created.box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('succeeded');

    const deleteCall = [...tailscaleClient.calls].reverse().find((call) => call.method === 'deleteDevice');
    expect(deleteCall?.args[1]).toBe(saved.tailnetDeviceId);
  });

  it('logs tailnet cleanup failures as warnings but completes docker cleanup', async () => {
    const { orchestrator, boxes, tailscaleClient } = buildTailnetHarness();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const created = await orchestrator.createBox({ name: 'box-tailnet-warn' });
    expect(await waitForJob(orchestrator, created.job.id)).toBe('succeeded');

    const saved = boxes.get(created.box.id);
    if (!saved?.tailnetDeviceId) {
      throw new Error('Expected tailnet device id');
    }

    tailscaleClient.failOn.deleteDevice = new Error('tailscale delete failed');
    const removeJob = await orchestrator.removeBox(created.box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('succeeded');
    expect(boxes.get(created.box.id)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`tailnet cleanup failed for box ${saved.id}`)
    );

    warnSpy.mockRestore();
  });
});
