import { describe, expect, it } from 'vitest';

import { OrchestratorEvents } from '../src/events.js';
import { JobRunner } from '../src/job-runner.js';
import { DevboxOrchestrator } from '../src/orchestrator.js';
import { ConfigLockedError, SetupRequiredError, ValidationError } from '../src/errors.js';
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
  const orchestrator = new DevboxOrchestrator(
    runtime, boxes, jobs, runner, events,
    undefined, { DEV_PASSWORD: 'password' },
    tailnetConfig, tailscaleClient
  );
  return { runtime, orchestrator, boxes, tailnetConfig, tailscaleClient };
}

const SAMPLE_TAILNET_INPUT = {
  tailnet: 'example.com',
  oauthClientId: 'client-id',
  oauthClientSecret: 'client-secret'
};

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

  it('forwards follow/since/tail options when streaming managed box logs', async () => {
    const { runtime, orchestrator } = buildHarness();
    const created = await orchestrator.createBox({
      name: 'box-logs-options'
    });
    await waitForJob(orchestrator, created.job.id);

    const box = await orchestrator.getBox(created.box.id);
    if (!box?.containerId) {
      throw new Error('Expected container id');
    }

    runtime.pushLog(box.containerId, {
      stream: 'stdout',
      timestamp: new Date().toISOString(),
      line: 'hello'
    });

    const stream = await orchestrator.streamBoxLogs(box.id, {
      follow: true,
      since: '2026-01-01T00:00:00.000Z',
      tail: 200
    });

    for await (const _event of stream) {
      break;
    }

    expect(runtime.lastStreamContainerLogsContainerId).toBe(box.containerId);
    expect(runtime.lastStreamContainerLogsOptions).toEqual({
      follow: true,
      since: '2026-01-01T00:00:00.000Z',
      tail: 200
    });
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

describe('DevboxOrchestrator - Tailscale integration', () => {
  it('createBox fails when tailnet config absent', async () => {
    const { orchestrator } = buildTailnetHarness();

    await expect(
      orchestrator.createBox({ name: 'no-tailnet-box' })
    ).rejects.toBeInstanceOf(SetupRequiredError);
  });

  it('createBox succeeds with tailnet config and injects Tailscale env + capabilities', async () => {
    const { runtime, orchestrator, tailnetConfig, tailscaleClient } = buildTailnetHarness();
    tailnetConfig.set(SAMPLE_TAILNET_INPUT);

    // Set up mock exec to return a node ID
    runtime.defaultExecResult = {
      exitCode: 0,
      stdout: JSON.stringify({ Self: { ID: 'node-123' } }),
      stderr: ''
    };

    const { box, job } = await orchestrator.createBox({ name: 'tailnet-box' });
    expect(await waitForJob(orchestrator, job.id)).toBe('succeeded');

    // Verify mintAuthKey was called
    const mintCall = tailscaleClient.calls.find((c) => c.method === 'mintAuthKey');
    expect(mintCall).toBeTruthy();

    // Verify container capabilities
    const opts = runtime.lastCreateContainerOptions;
    expect(opts?.devices).toEqual([
      { PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }
    ]);
    expect(opts?.capAdd).toEqual(['NET_ADMIN', 'NET_RAW']);

    // Verify Tailscale env vars injected
    expect(opts?.env?.DEVBOX_TAILSCALE_AUTHKEY).toBeTruthy();
    expect(opts?.env?.DEVBOX_TAILSCALE_HOSTNAME).toMatch(/^devbox-tailnet-box-/);
    expect(opts?.env?.DEVBOX_TAILSCALE_STATE_DIR).toBe('/var/lib/tailscale');

    // Verify tailnetUrl and nodeId persisted
    const saved = await orchestrator.getBox(box.id);
    expect(saved?.tailnetUrl).toMatch(/^ssh:\/\/devbox-tailnet-box-/);
    expect(saved?.tailnetNodeId).toBe('node-123');
  });

  it('config lock rejects update/delete when boxes exist', async () => {
    const { orchestrator, tailnetConfig, runtime } = buildTailnetHarness();
    tailnetConfig.set(SAMPLE_TAILNET_INPUT);

    runtime.defaultExecResult = {
      exitCode: 0,
      stdout: JSON.stringify({ Self: { ID: 'node-456' } }),
      stderr: ''
    };

    const { job } = await orchestrator.createBox({ name: 'lock-test-box' });
    await waitForJob(orchestrator, job.id);

    await expect(
      orchestrator.setTailnetConfig(SAMPLE_TAILNET_INPUT)
    ).rejects.toBeInstanceOf(ConfigLockedError);

    await expect(
      orchestrator.deleteTailnetConfig()
    ).rejects.toBeInstanceOf(ConfigLockedError);
  });

  it('getTailnetConfig redacts the OAuth secret', async () => {
    const { orchestrator, tailnetConfig } = buildTailnetHarness();
    tailnetConfig.set(SAMPLE_TAILNET_INPUT);

    const config = await orchestrator.getTailnetConfig();
    expect(config).toBeTruthy();
    expect(config!.oauthClientSecret).toBe('********');
    expect(config!.tailnet).toBe('example.com');
  });

  it('removeBox cleans up Tailnet device by nodeId', async () => {
    const { runtime, orchestrator, tailnetConfig, tailscaleClient } = buildTailnetHarness();
    tailnetConfig.set(SAMPLE_TAILNET_INPUT);

    runtime.defaultExecResult = {
      exitCode: 0,
      stdout: JSON.stringify({ Self: { ID: 'node-789' } }),
      stderr: ''
    };

    tailscaleClient.devices = [
      { id: 'device-1', nodeId: 'node-789', hostname: 'devbox-test', name: 'devbox-test' }
    ];

    const { box, job } = await orchestrator.createBox({ name: 'cleanup-test' });
    await waitForJob(orchestrator, job.id);

    const removeJob = await orchestrator.removeBox(box.id);
    expect(await waitForJob(orchestrator, removeJob.id)).toBe('succeeded');

    // Verify deleteDevice was called
    const deleteCall = tailscaleClient.calls.find((c) => c.method === 'deleteDevice');
    expect(deleteCall).toBeTruthy();
    expect(deleteCall!.args[1]).toBe('device-1');
  });

  it('missing container enqueues cleanup job when tailnet is configured', async () => {
    const { runtime, orchestrator, boxes, tailnetConfig, tailscaleClient } = buildTailnetHarness();
    tailnetConfig.set(SAMPLE_TAILNET_INPUT);

    runtime.defaultExecResult = {
      exitCode: 0,
      stdout: JSON.stringify({ Self: { ID: 'node-cleanup' } }),
      stderr: ''
    };

    tailscaleClient.devices = [
      { id: 'device-cleanup', nodeId: 'node-cleanup', hostname: 'devbox-ext-del', name: 'devbox-ext-del' }
    ];

    const { box, job } = await orchestrator.createBox({ name: 'ext-del-box' });
    await waitForJob(orchestrator, job.id);

    const initial = await orchestrator.getBox(box.id);
    if (!initial?.containerId) {
      throw new Error('Expected container id');
    }

    // Simulate external container deletion
    runtime.containers.delete(initial.containerId);

    // Start monitor to trigger reconciliation
    await orchestrator.startRuntimeStatusMonitor();

    runtime.emitContainerEvent({
      containerId: initial.containerId,
      action: 'destroy',
      labels: managedLabels(box.id),
      timestamp: new Date().toISOString()
    });

    // Wait for cleanup job to complete
    await waitForCondition(() => boxes.get(box.id) === null, 5_000);
    await orchestrator.stopRuntimeStatusMonitor();

    // Verify device was cleaned up
    const deleteCall = tailscaleClient.calls.find((c) => c.method === 'deleteDevice');
    expect(deleteCall).toBeTruthy();
  });
});
