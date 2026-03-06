import { randomUUID } from 'node:crypto';

import { ConfigLockedError, NotFoundError, SecurityError, SetupRequiredError, ValidationError } from './errors.js';
import type { OrchestratorEvents } from './events.js';
import { JobRunner, publishJob } from './job-runner.js';
import type { BoxRepository, JobRepository, TailnetConfigRepository } from './repositories.js';
import {
  assertManaged,
  managedLabels,
  MANAGED_LABELS,
  type ContainerRuntimeStatus,
  type DockerRuntime,
  type ManagedResourceLabelSpec,
  type ManagedResourceRole
} from './runtime.js';
import type { TailscaleClient, TailscaleDevice } from './tailscale-client.js';
import type {
  Box,
  CreateBoxInput,
  CreateBoxResult,
  InternalBox,
  Job,
  JobFilter,
  LogEvent,
  LogOptions,
  TailnetConfig,
  TailnetConfigInput
} from './types.js';
import { toPublicBox } from './types.js';
import { validateCreateBoxInput } from './validation.js';

function groupName(boxId: string): string {
  return `devbox-${boxId}`;
}

function networkName(boxId: string): string {
  return `devbox-net-${boxId}`;
}

function workspaceVolumeName(boxId: string): string {
  return `devbox-workspace-${boxId}`;
}

function tailscaleStateVolumeName(boxId: string): string {
  return `devbox-tsstate-${boxId}`;
}

function workspaceContainerName(boxId: string): string {
  return `devbox-workspace-${boxId}`;
}

function tailscaleContainerName(boxId: string): string {
  return `devbox-tailscale-${boxId}`;
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

const STABLE_RECONCILE_STATUSES = new Set<InternalBox['status']>(['running', 'stopped', 'error']);
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
const DEVICE_CAPTURE_RETRY_DELAYS = [1_000, 2_000, 3_000, 5_000, 8_000, 13_000] as const;

interface CleanupBoxResourcesResult {
  ok: boolean;
  errors: string[];
}

interface BoxResourceGroup {
  group: string;
  networkName: string;
  workspaceVolumeName: string;
  tailscaleStateVolumeName: string;
  workspaceContainerName: string;
  tailscaleContainerName: string;
}

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
    private readonly tailscaleClient: TailscaleClient | null = null,
    private readonly tailscaleSidecarImage = 'devbox-tailscale-sidecar:local',
    private readonly deviceCaptureRetryDelays: readonly number[] = DEVICE_CAPTURE_RETRY_DELAYS
  ) {}

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
    const boxCount = this.boxes.count();
    if (boxCount > 0) {
      throw new ConfigLockedError(`Cannot modify tailnet config while ${boxCount} boxes exist`, boxCount);
    }
    const config = this.tailnetConfigs.set(input);
    return { ...config, oauthClientSecret: '********' };
  }

  async deleteTailnetConfig(): Promise<void> {
    if (!this.tailnetConfigs) {
      throw new ValidationError('Tailnet configuration is not available');
    }
    const boxCount = this.boxes.count();
    if (boxCount > 0) {
      throw new ConfigLockedError(`Cannot delete tailnet config while ${boxCount} boxes exist`, boxCount);
    }
    this.tailnetConfigs.delete();
  }

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[orchestrator] runtime status monitor shutdown warning: ${message}`);
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
    const resources = this.resourceGroup(id);
    let box: InternalBox;
    try {
      box = this.boxes.create({
        id,
        name: input.name,
        image: this.runtimeImage,
        status: 'creating',
        workspaceContainerId: null,
        tailscaleContainerId: null,
        networkName: resources.networkName,
        workspaceVolumeName: resources.workspaceVolumeName,
        tailscaleStateVolumeName: resources.tailscaleStateVolumeName,
        tailnetUrl: null,
        tailnetDeviceId: null
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
        await this.runtime.createNetwork(
          box.networkName,
          this.labels(box.id, 'shared', 'network')
        );

        ctx.setProgress(12, 'Creating workspace volume');
        await this.runtime.createVolume(
          box.workspaceVolumeName,
          this.labels(box.id, 'workspace', 'volume')
        );

        ctx.setProgress(18, 'Creating tailscale state volume');
        await this.runtime.createVolume(
          box.tailscaleStateVolumeName,
          this.labels(box.id, 'tailscale', 'volume')
        );

        if (!tailnetConfig || !this.tailscaleClient) {
          throw new SetupRequiredError('Tailnet configuration required before creating boxes. Complete setup first.');
        }

        ctx.setProgress(25, 'Minting Tailscale auth key');
        const authKey = await this.tailscaleClient.mintAuthKey(tailnetConfig);
        const shortId = box.id.slice(0, 8);
        const tailnetHostname = `${tailnetConfig.hostnamePrefix}-${box.name}-${shortId}`;

        ctx.setProgress(40, 'Creating tailscale sidecar');
        const tailscaleContainerId = await this.runtime.createContainer({
          name: resources.tailscaleContainerName,
          image: this.tailscaleSidecarImage,
          networkMode: box.networkName,
          labels: this.labels(box.id, 'tailscale', 'container'),
          env: {
            DEVBOX_TAILSCALE_AUTHKEY: authKey.key,
            DEVBOX_TAILSCALE_HOSTNAME: tailnetHostname
          },
          mounts: [
            {
              Type: 'volume',
              Source: box.tailscaleStateVolumeName,
              Target: '/var/lib/tailscale'
            }
          ],
          devices: [
            {
              PathOnHost: '/dev/net/tun',
              PathInContainer: '/dev/net/tun',
              CgroupPermissions: 'rwm'
            }
          ],
          capAdd: ['NET_ADMIN', 'NET_RAW']
        });

        box = this.boxes.update(box.id, {
          tailscaleContainerId,
          tailnetUrl: `ssh://${tailnetHostname}`
        });
        this.publishBox(box);

        ctx.setProgress(55, 'Starting tailscale sidecar');
        await this.runtime.startContainer(tailscaleContainerId);

        ctx.setProgress(65, 'Creating workspace container');
        const workspaceContainerId = await this.runtime.createContainer({
          name: resources.workspaceContainerName,
          image: box.image,
          networkMode: `container:${resources.tailscaleContainerName}`,
          labels: this.labels(box.id, 'workspace', 'container'),
          env: { ...(input.env ?? {}), ...this.runtimeEnv },
          command: input.command,
          mounts: [
            {
              Type: 'volume',
              Source: box.workspaceVolumeName,
              Target: '/workspace'
            }
          ],
          capDrop: ['NET_RAW']
        });

        box = this.boxes.update(box.id, { workspaceContainerId });
        this.publishBox(box);

        ctx.setProgress(75, 'Starting workspace container');
        await this.runtime.startContainer(workspaceContainerId);

        ctx.setProgress(85, 'Waiting for Tailscale device registration');
        const device = await this.captureDeviceByHostname(tailnetConfig, tailnetHostname);
        if (!device) {
          throw new ValidationError(
            `Timed out waiting for Tailscale device registration for hostname ${tailnetHostname}.`
          );
        }
        box = this.boxes.update(box.id, { tailnetDeviceId: device.id, status: 'running' });
        this.publishBox(box);
      } catch (error) {
        const latestBox = this.boxes.get(box.id) ?? box;
        const cleanup = await this.cleanupBoxResources(latestBox, { stopContainers: true });
        if (cleanup.ok) {
          if (this.boxes.get(box.id)) {
            this.boxes.delete(box.id);
            this.publishBoxRemoved(box.id);
          }
        } else {
          this.markBoxError(box.id);
          await this.runCleanupJob(this.boxes.get(box.id) ?? latestBox, 'Cleanup after failed create');
        }
        throw error;
      }
    });

    return { box: toPublicBox(box), job };
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
    if (!box.workspaceContainerId || !box.tailscaleContainerId) {
      throw new ValidationError(`Box is missing grouped runtime resources: ${boxId}`);
    }

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
        ctx.setProgress(30, 'Starting tailscale sidecar');
        await this.assertManagedContainer(box.id, box.tailscaleContainerId!, 'tailscale');
        await this.runtime.startContainer(box.tailscaleContainerId!);

        ctx.setProgress(60, 'Starting workspace container');
        await this.assertManagedContainer(box.id, box.workspaceContainerId!, 'workspace');
        await this.runtime.startContainer(box.workspaceContainerId!);

        const tailnetConfig = this.tailnetConfigs?.get() ?? null;
        const hostname = this.tailnetHostname(box);
        if (!tailnetConfig || !this.tailscaleClient || !hostname) {
          throw new ValidationError('Box is missing tailnet configuration needed for restart verification.');
        }

        ctx.setProgress(80, 'Verifying Tailscale device registration');
        const device = await this.captureDeviceByHostname(tailnetConfig, hostname);
        if (!device) {
          throw new ValidationError(`Timed out waiting for Tailscale device registration for hostname ${hostname}.`);
        }

        const running = this.boxes.update(box.id, {
          status: 'running',
          tailnetDeviceId: device.id
        });
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

    this.jobRunner.enqueue(job.id, async () => {
      try {
        if (box.workspaceContainerId) {
          await this.assertManagedContainer(box.id, box.workspaceContainerId, 'workspace');
          await this.runtime.stopContainer(box.workspaceContainerId);
        }
        if (box.tailscaleContainerId) {
          await this.assertManagedContainer(box.id, box.tailscaleContainerId, 'tailscale');
          await this.runtime.stopContainer(box.tailscaleContainerId);
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
        ctx.setProgress(15, 'Cleaning up box resources');
        const cleanup = await this.cleanupBoxResources(this.boxes.get(box.id) ?? box, {
          stopContainers: true
        });
        if (!cleanup.ok) {
          this.markBoxError(box.id);
          await this.runCleanupJob(this.boxes.get(box.id) ?? box, 'Cleanup after failed removal');
          throw new Error(cleanup.errors.join('; '));
        }

        this.boxes.delete(box.id);
        this.publishBoxRemoved(box.id);
      } catch (error) {
        if (this.boxes.get(box.id)) {
          this.markBoxError(box.id);
        }
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
    if (!box.workspaceContainerId) {
      throw new ValidationError('Box has no workspace container logs yet.');
    }

    await this.assertManagedContainer(box.id, box.workspaceContainerId, 'workspace');
    return this.streamManagedBoxLogs(box.id, box.workspaceContainerId, options);
  }

  private resourceGroup(boxId: string): BoxResourceGroup {
    return {
      group: groupName(boxId),
      networkName: networkName(boxId),
      workspaceVolumeName: workspaceVolumeName(boxId),
      tailscaleStateVolumeName: tailscaleStateVolumeName(boxId),
      workspaceContainerName: workspaceContainerName(boxId),
      tailscaleContainerName: tailscaleContainerName(boxId)
    };
  }

  private labels(
    boxId: string,
    role: ManagedResourceRole,
    kind: 'container' | 'volume' | 'network'
  ): Record<string, string> {
    const resources = this.resourceGroup(boxId);
    return managedLabels({
      boxId,
      group: resources.group,
      role,
      kind
    });
  }

  private containerSpec(boxId: string, role: ManagedResourceRole): ManagedResourceLabelSpec {
    return {
      boxId,
      group: this.resourceGroup(boxId).group,
      role,
      kind: 'container'
    };
  }

  private async captureDeviceByHostname(
    tailnetConfig: TailnetConfig,
    hostname: string
  ): Promise<TailscaleDevice | null> {
    for (let attempt = 0; attempt <= this.deviceCaptureRetryDelays.length; attempt++) {
      try {
        const device = await this.tailscaleClient?.findDeviceByHostname(tailnetConfig, hostname);
        if (device) {
          return device;
        }
      } catch {
        // Retry on next iteration
      }

      if (attempt === this.deviceCaptureRetryDelays.length) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, this.deviceCaptureRetryDelays[attempt]));
    }
    return null;
  }

  private tailnetHostname(box: InternalBox): string | null {
    if (!box.tailnetUrl?.startsWith('ssh://')) {
      return null;
    }
    return box.tailnetUrl.slice('ssh://'.length);
  }

  private async cleanupTailnetDevice(box: InternalBox): Promise<void> {
    const tailnetConfig = this.tailnetConfigs?.get() ?? null;
    if (!tailnetConfig || !this.tailscaleClient) {
      return;
    }

    let deviceId = box.tailnetDeviceId;
    let cleanupPath = deviceId ? `deviceId:${deviceId}` : null;
    if (!deviceId) {
      const hostname = this.tailnetHostname(box);
      if (hostname) {
        const device = await this.tailscaleClient.findDeviceByHostname(tailnetConfig, hostname);
        if (device) {
          deviceId = device.id;
          cleanupPath = `hostname:${hostname}`;
        }
      }
    }

    if (!deviceId) {
      console.warn(`[orchestrator] tailnet cleanup skipped for box ${box.id} (${groupName(box.id)}): missing device identity`);
      return;
    }

    try {
      await this.tailscaleClient.deleteDevice(tailnetConfig, deviceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[orchestrator] tailnet cleanup failed for box ${box.id} (${groupName(box.id)}, ${cleanupPath}): ${message}`
      );
    }
  }

  private async runCleanupJob(box: InternalBox, message = 'Cleanup after external deletion'): Promise<void> {
    if (this.cleanupInProgress.has(box.id)) {
      return;
    }
    this.cleanupInProgress.add(box.id);

    const job = this.jobs.create({
      type: 'cleanup',
      status: 'queued',
      boxId: box.id,
      progress: 0,
      message
    });
    publishJob(this.events, job);

    this.jobRunner.enqueue(job.id, async (ctx) => {
      try {
        ctx.setProgress(20, 'Cleaning up box resources');
        const cleanup = await this.cleanupBoxResources(this.boxes.get(box.id) ?? box, {
          stopContainers: true
        });
        if (!cleanup.ok) {
          this.markBoxError(box.id);
          throw new Error(cleanup.errors.join('; '));
        }

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

  private mapContainerStateToBoxStatus(status: ContainerRuntimeStatus): 'running' | 'stopped' | 'error' {
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

  private groupStatus(workspaceStatus: ContainerRuntimeStatus, tailscaleStatus: ContainerRuntimeStatus): InternalBox['status'] {
    const workspace = this.mapContainerStateToBoxStatus(workspaceStatus);
    const tailscale = this.mapContainerStateToBoxStatus(tailscaleStatus);

    if (workspace === 'running' && tailscale === 'running') {
      return 'running';
    }
    if (workspace === 'stopped' && tailscale === 'stopped') {
      return 'stopped';
    }
    return 'error';
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

    if (
      box.workspaceContainerId &&
      box.tailscaleContainerId &&
      containerId !== box.workspaceContainerId &&
      containerId !== box.tailscaleContainerId
    ) {
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

  private async reconcileBoxForRead(box: InternalBox): Promise<Box | null> {
    const reconciled = await this.reconcileBox(box, false, false);
    return reconciled ? toPublicBox(reconciled) : null;
  }

  private async reconcileBox(
    box: InternalBox,
    emitUpdate: boolean,
    allowErrorRecovery: boolean
  ): Promise<InternalBox | null> {
    if (!STABLE_RECONCILE_STATUSES.has(box.status)) {
      return box;
    }

    if (!box.workspaceContainerId || !box.tailscaleContainerId) {
      const result = this.updateBoxIfChanged(box.id, { status: 'error' });
      if (emitUpdate && result.changed && result.box) {
        this.publishBox(result.box);
      }
      return result.box ?? box;
    }

    let workspaceDetails: Awaited<ReturnType<DockerRuntime['inspectContainer']>>;
    let tailscaleDetails: Awaited<ReturnType<DockerRuntime['inspectContainer']>>;
    try {
      [workspaceDetails, tailscaleDetails] = await Promise.all([
        this.runtime.inspectContainer(box.workspaceContainerId),
        this.runtime.inspectContainer(box.tailscaleContainerId)
      ]);
    } catch {
      return box;
    }

    if (!workspaceDetails || !tailscaleDetails) {
      await this.runCleanupJob(box);
      return box;
    }

    try {
      assertManaged(workspaceDetails.labels, this.containerSpec(box.id, 'workspace'));
      assertManaged(tailscaleDetails.labels, this.containerSpec(box.id, 'tailscale'));
    } catch {
      const result = this.updateBoxIfChanged(box.id, { status: 'error' });
      if (emitUpdate && result.changed && result.box) {
        this.publishBox(result.box);
      }
      return result.box ?? box;
    }

    if (box.status === 'error' && !allowErrorRecovery) {
      return box;
    }

    const nextStatus = this.groupStatus(workspaceDetails.status, tailscaleDetails.status);
    const result = this.updateBoxIfChanged(box.id, { status: nextStatus });
    if (emitUpdate && result.changed && result.box) {
      this.publishBox(result.box);
    }
    return result.box ?? box;
  }

  private updateBoxIfChanged(
    boxId: string,
    patch: {
      status?: InternalBox['status'];
    }
  ): { box: InternalBox | null; changed: boolean } {
    const current = this.boxes.get(boxId);
    if (!current) {
      return { box: null, changed: false };
    }

    if (!STABLE_RECONCILE_STATUSES.has(current.status)) {
      return { box: current, changed: false };
    }

    const nextStatus = patch.status ?? current.status;
    if (current.status === nextStatus) {
      return { box: current, changed: false };
    }

    return {
      box: this.boxes.update(boxId, {
        status: nextStatus
      }),
      changed: true
    };
  }

  private markBoxError(boxId: string): void {
    const errorBox = this.boxes.update(boxId, { status: 'error' });
    this.publishBox(errorBox);
  }

  private requireBox(boxId: string): InternalBox {
    const box = this.boxes.get(boxId);
    if (!box) {
      throw new NotFoundError(`Box not found: ${boxId}`);
    }
    return box;
  }

  private async assertManagedContainer(
    boxId: string,
    containerId: string,
    role: ManagedResourceRole
  ): Promise<void> {
    const details = await this.runtime.inspectContainer(containerId);
    if (!details) {
      throw new NotFoundError(`Container not found: ${containerId}`);
    }

    try {
      assertManaged(details.labels, this.containerSpec(boxId, role));
    } catch {
      throw new SecurityError('Refusing operation on unmanaged container.');
    }
  }

  private publishBox(box: InternalBox): void {
    this.events.emit('box.updated', {
      type: 'box.updated',
      box: toPublicBox(box)
    });
  }

  private publishBoxRemoved(boxId: string): void {
    this.events.emit('box.removed', {
      type: 'box.removed',
      boxId
    });
  }

  private async cleanupBoxResources(
    box: InternalBox,
    options: { stopContainers: boolean }
  ): Promise<CleanupBoxResourcesResult> {
    const errors: string[] = [];

    await this.captureCleanupError(errors, async () => {
      await this.cleanupTailnetDevice(box);
    }, 'tailnet device cleanup');

    if (box.workspaceContainerId) {
      if (options.stopContainers) {
        await this.captureCleanupError(
          errors,
          async () => {
            await this.assertManagedContainer(box.id, box.workspaceContainerId!, 'workspace');
            await this.runtime.stopContainer(box.workspaceContainerId!);
          },
          `stop workspace container ${box.workspaceContainerId}`
        );
      }

      await this.captureCleanupError(
        errors,
        async () => {
          await this.assertManagedContainer(box.id, box.workspaceContainerId!, 'workspace');
          await this.runtime.removeContainer(box.workspaceContainerId!);
        },
        `remove workspace container ${box.workspaceContainerId}`
      );
    }

    if (box.tailscaleContainerId) {
      if (options.stopContainers) {
        await this.captureCleanupError(
          errors,
          async () => {
            await this.assertManagedContainer(box.id, box.tailscaleContainerId!, 'tailscale');
            await this.runtime.stopContainer(box.tailscaleContainerId!);
          },
          `stop tailscale container ${box.tailscaleContainerId}`
        );
      }

      await this.captureCleanupError(
        errors,
        async () => {
          await this.assertManagedContainer(box.id, box.tailscaleContainerId!, 'tailscale');
          await this.runtime.removeContainer(box.tailscaleContainerId!);
        },
        `remove tailscale container ${box.tailscaleContainerId}`
      );
    }

    await this.captureCleanupError(
      errors,
      async () => {
        await this.runtime.removeNetwork(box.networkName);
      },
      `remove network ${box.networkName}`
    );
    await this.captureCleanupError(
      errors,
      async () => {
        await this.runtime.removeVolume(box.workspaceVolumeName);
      },
      `remove workspace volume ${box.workspaceVolumeName}`
    );
    await this.captureCleanupError(
      errors,
      async () => {
        await this.runtime.removeVolume(box.tailscaleStateVolumeName);
      },
      `remove tailscale state volume ${box.tailscaleStateVolumeName}`
    );

    return {
      ok: errors.length === 0,
      errors
    };
  }

  private async captureCleanupError(
    errors: string[],
    work: () => Promise<void>,
    label: string
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (this.isMissingResourceError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${label}: ${message}`);
    }
  }

  private isMissingResourceError(error: unknown): boolean {
    if (error instanceof NotFoundError) {
      return true;
    }
    const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
    return statusCode === 404;
  }
}
