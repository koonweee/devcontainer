export const MANAGED_LABELS = {
  managed: 'com.devbox.managed',
  boxId: 'com.devbox.box_id',
  owner: 'com.devbox.owner'
} as const;

export const MANAGED_OWNER = 'orchestrator';

export type ContainerRuntimeStatus =
  | 'created'
  | 'restarting'
  | 'running'
  | 'removing'
  | 'paused'
  | 'exited'
  | 'dead'
  | 'unknown'
  | (string & {});

export interface ContainerDetails {
  id: string;
  labels: Record<string, string>;
  status: ContainerRuntimeStatus;
}

export interface CreateContainerOptions {
  name: string;
  image: string;
  networkName: string;
  volumeName: string;
  labels: Record<string, string>;
  env?: Record<string, string>;
  command?: string[];
}

export interface RuntimeLogLine {
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: string;
}

export interface RuntimeLogOptions {
  follow?: boolean;
  since?: string;
  tail?: number;
}

export interface RuntimeEventOptions {
  signal?: AbortSignal;
}

export interface ContainerRuntimeEvent {
  containerId: string;
  action: string;
  labels: Record<string, string>;
  timestamp: string;
}

export interface DockerRuntime {
  createNetwork(name: string, labels: Record<string, string>): Promise<void>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  createContainer(options: CreateContainerOptions): Promise<string>;
  startContainer(containerId: string): Promise<void>;
  stopContainer(containerId: string): Promise<void>;
  removeContainer(containerId: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
  inspectContainer(containerId: string): Promise<ContainerDetails | null>;
  streamContainerLogs(
    containerId: string,
    options: RuntimeLogOptions
  ): AsyncIterable<RuntimeLogLine>;
  streamContainerEvents(options?: RuntimeEventOptions): AsyncIterable<ContainerRuntimeEvent>;
}

export function managedLabels(boxId: string): Record<string, string> {
  return {
    [MANAGED_LABELS.managed]: 'true',
    [MANAGED_LABELS.boxId]: boxId,
    [MANAGED_LABELS.owner]: MANAGED_OWNER
  };
}

export function assertManaged(labels: Record<string, string>, boxId: string): void {
  if (
    labels[MANAGED_LABELS.managed] !== 'true' ||
    labels[MANAGED_LABELS.boxId] !== boxId ||
    labels[MANAGED_LABELS.owner] !== MANAGED_OWNER
  ) {
    throw new Error('Resource is not a managed devbox resource.');
  }
}
