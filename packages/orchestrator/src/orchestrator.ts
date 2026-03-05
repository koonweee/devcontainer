import { randomUUID } from 'node:crypto';

import { ConfigLockedError, NotFoundError, SecurityError, SetupRequiredError, ValidationError } from './errors.js';
import type { OrchestratorEvents } from './events.js';
import { JobRunner, publishJob } from './job-runner.js';
import type { BoxRepository, JobRepository, TailnetConfigRepository } from './repositories.js';
import {
  assertManaged,
  MANAGED_LABELS,
  managedLabels,
  type ContainerRuntimeStatus,
  type DockerRuntime
} from './runtime.js';
import type { TailscaleClient } from './tailscale-client.js';
import type {
  Box,
  CreateBoxInput,
  CreateBoxResult,
  Job,
  JobFilter,
  LogEvent,
  LogOptions,
  TailnetConfig,
  TailnetConfigInput
} from './types.js';
import { validateCreateBoxInput } from './validation.js';

function networkName(boxId: string): string {
  return `devbox-net-${boxId}`;
}

function volumeName(boxId: string): string {
  return `devbox-vol-${boxId}`;
}

function containerName(boxId: string): string {
  return `devbox-${boxId}`;
}

function isBoxNameConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  if (code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return true;
  }

  return error.message.includes('UNIQUE constraint failed: boxes.name');
}

const STABLE_RECONCILE_STATUSES = new Set<Box['status']>(['running', 'stopped', 'error']);
const RUNTIME_MONITOR_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const RUNTIME_RECONCILE_ACTIONS = new Set([
  'start',
  'stop',
  'die',
  'destroy',
  'pause',
  'unpause',
  'restart',
  'kill'
]);
const NODE_ID_RETRY_DELAYS = [1_000, 2_000, 3_000] as const;

/** Coordinates box lifecycle operations, jobs, logs, and security checks. */
export class DevboxOrchestrator {
  private runtimeMonitorAbortController: AbortController | null = null;
  private runtimeMonitorTask: Promise<void> | null = null;
  private readonly cleanupInProgress = new Set<string>();

  constructor(
    private readonly runtime: DockerRuntime,
    private readonly boxes: BoxRepository,
    private readonly jobs: JobRepository,
    private readonly jobRunner: JobRunner,
    readonly events: OrchestratorEvents,
    private readonly runtimeImage = 'devbox-runtime:local',
    private readonly runtimeEnv: Record<string, string> = {},
    private readonly tailnetConfigs: TailnetConfigRepository | null = null,
    private readonly tailscaleClient: TailscaleClient | null = null
  ) {}

  // --- Tailnet config management ---

  async getTailnetConfig(): Promise<(Omit<TailnetConfig, 'oauthClientSecret'> & { oauthClientSecret: string }) | null> {
    if (!this.tailnetConfigs) {
      return null;
    }
    const config = this.tailnetConfigs.get();
    if (!config) {
      return null;
    }
    return { ...config, oauthClientSecret: '********' };
  }

  async setTailnetConfig(input: TailnetConfigInput): Promise<Omit<TailnetConfig, 'oauthClientSecret'> & { oauthClientSecret: string }> {
    if (!this.tailnetConfigs) {
      throw new ValidationError('Tailnet configuration is not available');
    }
    if (this.boxes.count() > 0) {
      throw new ConfigLockedError('Cannot modify tailnet config while boxes exist');
    }
    const config = this.tailnetConfigs.set(input);
    return { ...config, oauthClientSecret: '********' };
  }

  async deleteTailnetConfig(): Promise<void> {
    if (!this.tailnetConfigs) {
      throw new ValidationError('Tailnet configuration is not available');
    }
    if (this.boxes.count() > 0) {
      throw new ConfigLockedError('Cannot delete tailnet config while boxes exist');
    }
    this.tailnetConfigs.delete();
  }

  // --- Box lifecycle ---

  async startRuntimeStatusMonitor(): Promise<void> {
    if (this.runtimeMonitorTask) {
      return;
    }

    const abortController = new AbortController();
    this.runtimeMonitorAbortController = abortController;
    this.runtimeMonitorTask = this.runRuntimeStatusMonitor(abortController.signal).finally(() => {
      if (this.runtimeMonitorAbortController === abortController) {
        this.runtimeMonitorAbortController = null;
      }
      if (this.runtimeMonitorTask) {
        this.runtimeMonitorTask = null;
      }
    });
  }

  async stopRuntimeStatusMonitor(): Promise<void> {
    this.runtimeMonitorAbortController?.abort();
    if (!this.runtimeMonitorTask) {
      return;
    }

    try {
      await this.runtimeMonitorTask;
    } catch {
      // Monitor failures are intentionally swallowed on shutdown.
    }
  }

  async createBox(input: CreateBoxInput): Promise<CreateBoxResult> {
    validateCreateBoxInput(input);

    const tailnetConfig = this.tailnetConfigs?.get() ?? null;
    if (this.tailnetConfigs && !tailnetConfig) {
      throw new SetupRequiredError('Tailnet configuration required before creating boxes. Complete setup first.');
    }

    const existing = this.boxes.getByName(input.name);
    if (existing) {
      throw new ValidationError(`Box name already exists: ${input.name}`);
    }

    const id = randomUUID();
    let box: Box;
    try {
      box = this.boxes.create({
        id,
        name: input.name,
        image: this.runtimeImage,
        status: 'creating',
        networkName: networkName(id),
        volumeName: volumeName(id)
      });
    } catch (error) {
      if (isBoxNameConstraintError(error)) {
        throw new ValidationError(`Box name already exists: ${input.name}`);
      }
      throw error;
    }
    this.publishBox(box);

    const job = this.jobs.create({
      type: 'create',
      status: 'queued',
      boxId: id,
      progress: 0,
      message: 'Create requested'
    });
    publishJob(this.events, job);

    this.jobRunner.enqueue(job.id, async (ctx) => {
      try {
        ctx.setProgress(5, 'Creating network');
        await this.runtime.createNetwork(box.networkName, managedLabels(box.id));

        ctx.setProgress(15, 'Creating volume');
        await this.runtime.createVolume(box.volumeName, managedLabels(box.id));

        // Mint Tailscale auth key if configured
        let tailscaleEnv: Record<string, string> = {};
        let tailnetHostname: string | undefined;
        if (tailnetConfig && this.tailscaleClient) {
          ctx.setProgress(25, 'Minting Tailscale auth key');
          const authKey = await this.tailscaleClient.mintAuthKey(tailnetConfig);
          const shortId = box.id.slice(0, 8);
          tailnetHostname = `${tailnetConfig.hostnamePrefix}-${box.name}-${shortId}`;
          tailscaleEnv = {
            DEVBOX_TAILSCALE_AUTHKEY: authKey.key,
            DEVBOX_TAILSCALE_HOSTNAME: tailnetHostname,
            DEVBOX_TAILSCALE_STATE_DIR: '/var/lib/tailscale'
          };
        }

        ctx.setProgress(40, 'Creating container');
        const containerEnv = { ...(input.env ?? {}), ...tailscaleEnv, ...this.runtimeEnv };
        const containerId = await this.runtime.createContainer({
          name: containerName(box.id),
          image: box.image,
          networkName: box.networkName,
          volumeName: box.volumeName,
          labels: managedLabels(box.id),
          env: containerEnv,
          command: input.command,
          devices: tailnetConfig
            ? [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }]
            : undefined,
          capAdd: tailnetConfig ? ['NET_ADMIN', 'NET_RAW'] : undefined
        });

        const creating = this.boxes.update(box.id, {
          containerId,
          status: 'creating',
          tailnetUrl: tailnetHostname ? `ssh://${tailnetHostname}` : null
        });
        this.publishBox(creating);

        ctx.setProgress(60, 'Starting container');
        await this.runtime.startContainer(containerId);

        // Capture Tailscale node ID
        if (tailnetConfig && this.tailscaleClient) {
          ctx.setProgress(75, 'Waiting for Tailscale node');
          const nodeId = await this.captureNodeId(containerId);
          if (nodeId) {
            this.boxes.update(box.id, { tailnetNodeId: nodeId });
          }
        }

        const running = this.boxes.update(box.id, {
          status: 'running'
        });
        this.publishBox(running);
      } catch (error) {
        this.markBoxError(box.id);
        throw error;
      }
    });

    return { box, job };
  }

  async listBoxes(): Promise<Box[]> {
    const boxes = await Promise.all(this.boxes.list().map((box) => this.reconcileBoxForRead(box)));
    return boxes.filter((box): box is Box => box !== null);
  }

  async getBox(boxId: string): Promise<Box | null> {
    const box = this.boxes.get(boxId);
    if (!box) {
      return null;
    }
    return this.reconcileBoxForRead(box);
  }

  async startBox(boxId: string): Promise<Job> {
    const box = this.requireBox(boxId);
    if (box.status !== 'stopped') {
      throw new ValidationError(`Only stopped boxes can be started: ${boxId}`);
    }
    if (!box.containerId) {
      throw new ValidationError(`Box has no container to start: ${boxId}`);
    }
    const containerId = box.containerId;

    const starting = this.boxes.update(boxId, { status: 'starting' });
    this.publishBox(starting);

    const job = this.jobs.create({
      type: 'start',
      status: 'queued',
      boxId,
      progress: 0,
      message: 'Start requested'
    });
    publishJob(this.events, job);

    this.jobRunner.enqueue(job.id, async (ctx) => {
      try {
        ctx.setProgress(50, 'Starting container');
        await this.assertManagedContainer(box.id, containerId);
        await this.runtime.startContainer(containerId);

        // Refresh Tailscale node ID after restart
        if (this.tailnetConfigs?.get() && this.tailscaleClient) {
          ctx.setProgress(75, 'Refreshing Tailscale node');
          const nodeId = await this.captureNodeId(containerId);
          if (nodeId) {
            this.boxes.update(box.id, { tailnetNodeId: nodeId });
          }
        }

        const running = this.boxes.update(box.id, { status: 'running' });
        this.publishBox(running);
      } catch (error) {
        this.markBoxError(box.id);
        throw error;
      }
    });

    return job;
  }

  async stopBox(boxId: string): Promise<Job> {
    const box = this.requireBox(boxId);

    const stopping = this.boxes.update(boxId, { status: 'stopping' });
    this.publishBox(stopping);

    const job = this.jobs.create({
      type: 'stop',
      status: 'queued',
      boxId,
      progress: 0,
      message: 'Stop requested'
    });
    publishJob(this.events, job);

    this.jobRunner.enqueue(job.id, async (ctx) => {
      try {
        if (box.containerId) {
          ctx.setProgress(50, 'Stopping container');
          await this.assertManagedContainer(box.id, box.containerId);
          await this.runtime.stopContainer(box.containerId);
        }

        const stopped = this.boxes.update(box.id, { status: 'stopped' });
        this.publishBox(stopped);
      } catch (error) {
        this.markBoxError(box.id);
        throw error;
      }
    });

    return job;
  }

  async removeBox(boxId: string): Promise<Job> {
    const box = this.requireBox(boxId);
    const removing = this.boxes.update(boxId, { status: 'removing' });
    this.publishBox(removing);

    const job = this.jobs.create({
      type: 'remove',
      status: 'queued',
      boxId,
      progress: 0,
      message: 'Remove requested'
    });
    publishJob(this.events, job);

    this.jobRunner.enqueue(job.id, async (ctx) => {
      try {
        if (box.containerId) {
          ctx.setProgress(15, 'Stopping container');
          await this.assertManagedContainer(box.id, box.containerId);
          await this.runtime.stopContainer(box.containerId);

          ctx.setProgress(30, 'Removing container');
          await this.runtime.removeContainer(box.containerId);
        }

        ctx.setProgress(45, 'Cleaning up Tailnet device');
        await this.cleanupTailnetDevice(box);

        ctx.setProgress(65, 'Removing network');
        await this.runtime.removeNetwork(box.networkName);

        ctx.setProgress(85, 'Removing volume');
        await this.runtime.removeVolume(box.volumeName);

        this.boxes.delete(box.id);
        this.publishBoxRemoved(box.id);
      } catch (error) {
        this.markBoxError(box.id);
        throw error;
      }
    });

    return job;
  }

  async listJobs(filter?: JobFilter): Promise<Job[]> {
    return this.jobs.list(filter);
  }

  async getJob(jobId: string): Promise<Job | null> {
    return this.jobs.get(jobId);
  }

  async streamBoxLogs(boxId: string, options: LogOptions): Promise<AsyncIterable<LogEvent>> {
    const box = this.requireBox(boxId);
    if (!box.containerId) {
      throw new ValidationError('Box has no container logs yet.');
    }

    await this.assertManagedContainer(box.id, box.containerId);
    return this.streamManagedBoxLogs(box.id, box.containerId, options);
  }

  // --- Private helpers ---

  private async captureNodeId(containerId: string): Promise<string | null> {
    for (let attempt = 0; attempt < NODE_ID_RETRY_DELAYS.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, NODE_ID_RETRY_DELAYS[attempt]));
      try {
        const result = await this.runtime.execContainer(containerId, ['tailscale', 'status', '--json']);
        if (result.exitCode === 0) {
          const parsed = JSON.parse(result.stdout) as { Self?: { ID?: string } };
          if (parsed.Self?.ID) {
            return parsed.Self.ID;
          }
        }
      } catch {
        // Retry on next iteration
      }
    }
    return null;
  }

  private async cleanupTailnetDevice(box: Box): Promise<void> {
    const tailnetConfig = this.tailnetConfigs?.get() ?? null;
    if (!tailnetConfig || !this.tailscaleClient) {
      return;
    }

    let cleanupPath = 'none';
    try {
      if (box.tailnetNodeId) {
        cleanupPath = `nodeId:${box.tailnetNodeId}`;
        const devices = await this.tailscaleClient.listDevices(tailnetConfig);
        const device = devices.find((d) => d.nodeId === box.tailnetNodeId);
        if (device) {
          await this.tailscaleClient.deleteDevice(tailnetConfig, device.id);
        }
      } else if (box.tailnetUrl) {
        // Hostname fallback: extract hostname from tailnetUrl (ssh://hostname)
        const hostname = box.tailnetUrl.replace('ssh://', '');
        cleanupPath = `hostname:${hostname}`;
        const devices = await this.tailscaleClient.listDevices(tailnetConfig);
        const device = devices.find((d) => d.hostname === hostname);
        if (device) {
          await this.tailscaleClient.deleteDevice(tailnetConfig, device.id);
        }
      }
    } catch (error) {
      // Tailnet cleanup failure is a warning, not a fatal error.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[orchestrator] tailnet cleanup failed for box ${box.id} (${cleanupPath}): ${message}`
      );
    }
  }

  private async runCleanupJob(box: Box): Promise<void> {
    if (this.cleanupInProgress.has(box.id)) {
      return;
    }
    this.cleanupInProgress.add(box.id);

    const job = this.jobs.create({
      type: 'cleanup',
      status: 'queued',
      boxId: box.id,
      progress: 0,
      message: 'Cleanup after external deletion'
    });
    publishJob(this.events, job);

    this.jobRunner.enqueue(job.id, async (ctx) => {
      try {
        ctx.setProgress(20, 'Cleaning up Tailnet device');
        await this.cleanupTailnetDevice(box);

        ctx.setProgress(50, 'Removing network');
        try {
          await this.runtime.removeNetwork(box.networkName);
        } catch { /* best effort */ }

        ctx.setProgress(75, 'Removing volume');
        try {
          await this.runtime.removeVolume(box.volumeName);
        } catch { /* best effort */ }

        this.boxes.delete(box.id);
        this.publishBoxRemoved(box.id);
      } finally {
        this.cleanupInProgress.delete(box.id);
      }
    });
  }

  private async *streamManagedBoxLogs(
    boxId: string,
    containerId: string,
    options: LogOptions
  ): AsyncIterable<LogEvent> {
    for await (const item of this.runtime.streamContainerLogs(containerId, options)) {
      const log: LogEvent = {
        boxId,
        stream: item.stream,
        line: item.line,
        timestamp: item.timestamp
      };
      this.events.emit('box.logs', { type: 'box.logs', boxId, log });
      yield log;
    }
  }

  private mapContainerStateToBoxStatus(status: ContainerRuntimeStatus): Box['status'] {
    switch (status) {
      case 'running':
      case 'restarting':
      case 'paused':
        return 'running';
      case 'created':
      case 'exited':
      case 'dead':
      case 'removing':
        return 'stopped';
      default:
        return 'error';
    }
  }

  private async runRuntimeStatusMonitor(signal: AbortSignal): Promise<void> {
    await this.reconcileStableBoxesForMonitor();

    let reconnectAttempts = 0;
    while (!signal.aborted) {
      try {
        for await (const event of this.runtime.streamContainerEvents({ signal })) {
          if (signal.aborted) {
            break;
          }
          if (!RUNTIME_RECONCILE_ACTIONS.has(event.action)) {
            continue;
          }

          const boxId = event.labels[MANAGED_LABELS.boxId];
          if (!boxId) {
            continue;
          }

          await this.reconcileBoxByIdForMonitor(boxId, event.containerId, event.action === 'start');
        }
        reconnectAttempts = 0;
      } catch {
        if (signal.aborted) {
          return;
        }
      }

      if (signal.aborted) {
        return;
      }

      const delay =
        RUNTIME_MONITOR_BACKOFF_MS[
          Math.min(reconnectAttempts, RUNTIME_MONITOR_BACKOFF_MS.length - 1)
        ];
      reconnectAttempts += 1;
      await this.sleepWithAbort(delay, signal);
    }
  }

  private async reconcileStableBoxesForMonitor(): Promise<void> {
    const allBoxes = this.boxes.list();
    for (const box of allBoxes) {
      if (!STABLE_RECONCILE_STATUSES.has(box.status)) {
        continue;
      }
      await this.reconcileBox(box, true, false);
    }
  }

  private async reconcileBoxByIdForMonitor(
    boxId: string,
    containerId: string,
    allowErrorRecovery: boolean
  ): Promise<void> {
    const box = this.boxes.get(boxId);
    if (!box) {
      return;
    }

    if (box.containerId && box.containerId !== containerId) {
      return;
    }

    await this.reconcileBox(box, true, allowErrorRecovery);
  }

  private sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async reconcileBoxForRead(box: Box): Promise<Box | null> {
    return this.reconcileBox(box, false, false);
  }

  private async reconcileBox(
    box: Box,
    emitUpdate: boolean,
    allowErrorRecovery: boolean
  ): Promise<Box | null> {
    if (!STABLE_RECONCILE_STATUSES.has(box.status)) {
      return box;
    }

    if (!box.containerId) {
      if (box.status === 'stopped' || box.status === 'error') {
        return box;
      }
      const result = this.updateBoxIfChanged(box.id, {
        status: 'error',
        containerId: null
      });
      if (emitUpdate && result.changed && result.box) {
        this.publishBox(result.box);
      }
      return result.box ?? box;
    }

    let details: Awaited<ReturnType<DockerRuntime['inspectContainer']>>;
    try {
      details = await this.runtime.inspectContainer(box.containerId);
    } catch {
      // Read paths must stay available if runtime inspect transiently fails.
      return box;
    }

    if (!details) {
      // Container externally deleted - enqueue cleanup job instead of hard delete
      if (emitUpdate && this.tailnetConfigs) {
        await this.runCleanupJob(box);
        return box;
      }
      this.boxes.delete(box.id);
      if (emitUpdate) {
        this.publishBoxRemoved(box.id);
      }
      return null;
    }

    try {
      assertManaged(details.labels, box.id);
    } catch {
      const result = this.updateBoxIfChanged(box.id, {
        status: 'error',
        containerId: box.containerId
      });
      if (emitUpdate && result.changed && result.box) {
        this.publishBox(result.box);
      }
      return result.box ?? box;
    }

    if (box.status === 'error' && !allowErrorRecovery) {
      return box;
    }

    const result = this.updateBoxIfChanged(box.id, {
      status: this.mapContainerStateToBoxStatus(details.status),
      containerId: box.containerId
    });
    if (emitUpdate && result.changed && result.box) {
      this.publishBox(result.box);
    }
    return result.box ?? box;
  }

  private updateBoxIfChanged(
    boxId: string,
    patch: {
      status?: Box['status'];
      containerId?: string | null;
    }
  ): { box: Box | null; changed: boolean } {
    const current = this.boxes.get(boxId);
    if (!current) {
      return { box: null, changed: false };
    }

    if (!STABLE_RECONCILE_STATUSES.has(current.status)) {
      return { box: current, changed: false };
    }

    const nextStatus = patch.status ?? current.status;
    const nextContainerId = patch.containerId === undefined ? current.containerId : patch.containerId;

    if (current.status === nextStatus && current.containerId === nextContainerId) {
      return { box: current, changed: false };
    }

    return {
      box: this.boxes.update(boxId, {
        status: nextStatus,
        containerId: nextContainerId
      }),
      changed: true
    };
  }

  private markBoxError(boxId: string): void {
    const errorBox = this.boxes.update(boxId, { status: 'error' });
    this.publishBox(errorBox);
  }

  private requireBox(boxId: string): Box {
    const box = this.boxes.get(boxId);
    if (!box) {
      throw new NotFoundError(`Box not found: ${boxId}`);
    }
    return box;
  }

  private async assertManagedContainer(boxId: string, containerId: string): Promise<void> {
    const details = await this.runtime.inspectContainer(containerId);
    if (!details) {
      throw new NotFoundError(`Container not found: ${containerId}`);
    }

    try {
      assertManaged(details.labels, boxId);
    } catch {
      throw new SecurityError('Refusing operation on unmanaged container.');
    }
  }

  private publishBox(box: Box): void {
    this.events.emit('box.updated', {
      type: 'box.updated',
      box
    });
  }

  private publishBoxRemoved(boxId: string): void {
    this.events.emit('box.removed', {
      type: 'box.removed',
      boxId
    });
  }
}
