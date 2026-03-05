import type {
  ContainerRuntimeEvent,
  ContainerDetails,
  ContainerRuntimeStatus,
  CreateContainerOptions,
  DockerRuntime,
  RuntimeEventOptions,
  RuntimeLogLine,
  RuntimeLogOptions
} from '../runtime.js';

interface FakeContainer {
  id: string;
  labels: Record<string, string>;
  status: ContainerRuntimeStatus;
  logs: RuntimeLogLine[];
}

/** Simulates Docker runtime behavior without touching Docker Engine. */
export class MockDockerRuntime implements DockerRuntime {
  readonly networks = new Set<string>();
  readonly volumes = new Set<string>();
  readonly containers = new Map<string, FakeContainer>();
  lastCreateContainerOptions: CreateContainerOptions | null = null;
  failOn: Partial<Record<keyof DockerRuntime, Error>> = {};
  private readonly containerEvents: ContainerRuntimeEvent[] = [];
  private readonly eventWaiters: Array<() => void> = [];

  private containerCounter = 0;

  async createNetwork(name: string): Promise<void> {
    this.throwIfConfigured('createNetwork');
    this.networks.add(name);
  }

  async createVolume(name: string): Promise<void> {
    this.throwIfConfigured('createVolume');
    this.volumes.add(name);
  }

  async createContainer(options: CreateContainerOptions): Promise<string> {
    this.throwIfConfigured('createContainer');
    this.lastCreateContainerOptions = options;
    this.containerCounter += 1;
    const id = `mock-${this.containerCounter}`;
    this.containers.set(id, {
      id,
      labels: options.labels,
      status: 'created',
      logs: []
    });
    return id;
  }

  async startContainer(containerId: string): Promise<void> {
    this.throwIfConfigured('startContainer');
    const container = this.containers.get(containerId);
    if (!container) {
      return;
    }
    container.status = 'running';
  }

  async stopContainer(containerId: string): Promise<void> {
    this.throwIfConfigured('stopContainer');
    const container = this.containers.get(containerId);
    if (!container) {
      return;
    }
    container.status = 'exited';
  }

  async removeContainer(containerId: string): Promise<void> {
    this.throwIfConfigured('removeContainer');
    this.containers.delete(containerId);
  }

  async removeNetwork(name: string): Promise<void> {
    this.throwIfConfigured('removeNetwork');
    this.networks.delete(name);
  }

  async removeVolume(name: string): Promise<void> {
    this.throwIfConfigured('removeVolume');
    this.volumes.delete(name);
  }

  async inspectContainer(containerId: string): Promise<ContainerDetails | null> {
    this.throwIfConfigured('inspectContainer');
    const container = this.containers.get(containerId);
    if (!container) {
      return null;
    }
    return {
      id: container.id,
      labels: container.labels,
      status: container.status
    };
  }

  async *streamContainerLogs(
    containerId: string,
    _options: RuntimeLogOptions
  ): AsyncIterable<RuntimeLogLine> {
    this.throwIfConfigured('streamContainerLogs');
    const container = this.containers.get(containerId);
    for (const log of container?.logs ?? []) {
      yield log;
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
    container.status = status;
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
