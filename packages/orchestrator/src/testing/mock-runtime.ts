import { buildBoxContainerCreateRequest } from '../box-runtime.js';
import type {
  ContainerRuntimeEvent,
  ContainerDetails,
  ContainerRuntimeStatus,
  CreateBoxContainerOptions,
  DockerRuntime,
  RuntimeEventOptions,
  RuntimeLogLine,
  RuntimeLogOptions
} from '../runtime.js';

interface FakeContainer {
  details: ContainerDetails;
  logs: RuntimeLogLine[];
  options: CreateBoxContainerOptions;
}

/** Simulates Docker runtime behavior without touching Docker Engine. */
export class MockDockerRuntime implements DockerRuntime {
  readonly networks = new Set<string>();
  readonly volumes = new Set<string>();
  readonly containers = new Map<string, FakeContainer>();
  readonly operations: string[] = [];
  lastCreateBoxContainerOptions: CreateBoxContainerOptions | null = null;
  lastStreamContainerLogsOptions: RuntimeLogOptions | null = null;
  lastStreamContainerLogsContainerId: string | null = null;
  lastStreamContainerLogsSignal: AbortSignal | null = null;
  holdFollowLogStreamOpen = false;
  logStreamAbortCount = 0;
  failOn: Partial<Record<keyof DockerRuntime, Error>> = {};
  private readonly containerEvents: ContainerRuntimeEvent[] = [];
  private readonly eventWaiters: Array<() => void> = [];

  private containerCounter = 0;

  async createNetwork(name: string): Promise<void> {
    this.throwIfConfigured('createNetwork');
    this.operations.push(`createNetwork:${name}`);
    this.networks.add(name);
  }

  async createVolume(name: string): Promise<void> {
    this.throwIfConfigured('createVolume');
    this.operations.push(`createVolume:${name}`);
    this.volumes.add(name);
  }

  async createBoxContainer(options: CreateBoxContainerOptions): Promise<string> {
    this.throwIfConfigured('createBoxContainer');
    this.operations.push(`createBoxContainer:${options.name}`);
    this.lastCreateBoxContainerOptions = options;
    this.containerCounter += 1;
    const id = `mock-${this.containerCounter}`;
    const request = buildBoxContainerCreateRequest(options);
    this.containers.set(id, {
      details: {
        id,
        labels: options.labels,
        status: 'created',
        networkMode: options.networkName,
        attachedNetworks: [options.networkName],
        publishedPorts: [],
        exposedPorts: [],
        mounts: request.HostConfig.Mounts.map((mount) => ({
          type: mount.Type,
          source: mount.Source,
          target: mount.Target,
          readOnly: mount.ReadOnly
        })),
        devices: request.HostConfig.Devices,
        capAdd: request.HostConfig.CapAdd,
        privileged: request.HostConfig.Privileged
      },
      logs: [],
      options
    });
    return id;
  }

  async startContainer(containerId: string): Promise<void> {
    this.throwIfConfigured('startContainer');
    this.operations.push(`startContainer:${containerId}`);
    const container = this.containers.get(containerId);
    if (!container) {
      return;
    }
    container.details.status = 'running';
  }

  async stopContainer(containerId: string): Promise<void> {
    this.throwIfConfigured('stopContainer');
    this.operations.push(`stopContainer:${containerId}`);
    const container = this.containers.get(containerId);
    if (!container) {
      return;
    }
    container.details.status = 'exited';
  }

  async removeContainer(containerId: string): Promise<void> {
    this.throwIfConfigured('removeContainer');
    this.operations.push(`removeContainer:${containerId}`);
    this.containers.delete(containerId);
  }

  async removeNetwork(name: string): Promise<void> {
    this.throwIfConfigured('removeNetwork');
    this.operations.push(`removeNetwork:${name}`);
    this.networks.delete(name);
  }

  async removeVolume(name: string): Promise<void> {
    this.throwIfConfigured('removeVolume');
    this.operations.push(`removeVolume:${name}`);
    this.volumes.delete(name);
  }

  async inspectContainer(containerId: string): Promise<ContainerDetails | null> {
    this.throwIfConfigured('inspectContainer');
    const container = this.containers.get(containerId);
    if (!container) {
      return null;
    }
    return structuredClone(container.details);
  }

  async *streamContainerLogs(
    containerId: string,
    options: RuntimeLogOptions
  ): AsyncIterable<RuntimeLogLine> {
    this.throwIfConfigured('streamContainerLogs');
    this.lastStreamContainerLogsContainerId = containerId;
    this.lastStreamContainerLogsOptions = options;
    this.lastStreamContainerLogsSignal = options.signal ?? null;
    const container = this.containers.get(containerId);
    for (const log of container?.logs ?? []) {
      yield log;
    }
    if (options.follow && this.holdFollowLogStreamOpen) {
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          this.logStreamAbortCount += 1;
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        if (options.signal?.aborted) {
          this.logStreamAbortCount += 1;
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  async *streamContainerEvents(
    options: RuntimeEventOptions = {}
  ): AsyncIterable<ContainerRuntimeEvent> {
    this.throwIfConfigured('streamContainerEvents');

    while (true) {
      if (options.signal?.aborted) {
        return;
      }

      const next = this.containerEvents.shift();
      if (next) {
        yield next;
        continue;
      }

      await new Promise<void>((resolve) => {
        const onAbort = () => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        if (options.signal) {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
        this.eventWaiters.push(() => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
  }

  pushLog(containerId: string, log: RuntimeLogLine): void {
    const container = this.containers.get(containerId);
    if (!container) {
      return;
    }
    container.logs.push(log);
  }

  setContainerStatus(containerId: string, status: ContainerRuntimeStatus): void {
    const container = this.containers.get(containerId);
    if (!container) {
      return;
    }
    container.details.status = status;
  }

  updateContainerDetails(containerId: string, patch: Partial<ContainerDetails>): void {
    const container = this.containers.get(containerId);
    if (!container) {
      return;
    }
    container.details = {
      ...container.details,
      ...patch
    };
  }

  emitContainerEvent(event: ContainerRuntimeEvent): void {
    this.containerEvents.push(event);
    const waiter = this.eventWaiters.shift();
    if (waiter) {
      waiter();
    }
  }

  private throwIfConfigured(method: keyof DockerRuntime): void {
    const error = this.failOn[method];
    if (error) {
      if (method === 'streamContainerEvents') {
        delete this.failOn.streamContainerEvents;
      }
      throw error;
    }
  }
}
