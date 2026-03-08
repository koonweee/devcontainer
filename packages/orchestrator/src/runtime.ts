export const MANAGED_LABELS = {
  managed: 'com.devbox.managed',
  boxId: 'com.devbox.box_id',
  owner: 'com.devbox.owner',
  kind: 'com.devbox.kind'
} as const;

export const MANAGED_OWNER = 'orchestrator';

export type ManagedResourceKind = 'container' | 'volume' | 'network';

export interface ManagedResourceLabelSpec {
  boxId: string;
  kind: ManagedResourceKind;
}

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
  networkMode: string | null;
  attachedNetworks: string[];
  publishedPorts: PublishedContainerPort[];
  exposedPorts: string[];
  mounts: ContainerMount[];
  devices: ContainerDevice[];
  capAdd: string[];
  privileged: boolean;
}

export interface ContainerDevice {
  PathOnHost: string;
  PathInContainer: string;
  CgroupPermissions: string;
}

export interface ContainerMount {
  type: string;
  source: string | null;
  target: string | null;
  readOnly: boolean;
}

export interface PublishedContainerPort {
  containerPort: string;
  hostPort: string;
  hostIp: string | null;
}

export interface CreateBoxContainerOptions {
  name: string;
  image: string;
  networkName: string;
  volumeName: string;
  labels: Record<string, string>;
  dnsServers?: string[];
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
  signal?: AbortSignal;
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
  createBoxContainer(options: CreateBoxContainerOptions): Promise<string>;
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

export function managedLabels(spec: ManagedResourceLabelSpec): Record<string, string> {
  return {
    [MANAGED_LABELS.managed]: 'true',
    [MANAGED_LABELS.boxId]: spec.boxId,
    [MANAGED_LABELS.owner]: MANAGED_OWNER,
    [MANAGED_LABELS.kind]: spec.kind
  };
}

export function assertManaged(
  labels: Record<string, string>,
  spec: ManagedResourceLabelSpec
): void {
  if (
    labels[MANAGED_LABELS.managed] !== 'true' ||
    labels[MANAGED_LABELS.boxId] !== spec.boxId ||
    labels[MANAGED_LABELS.owner] !== MANAGED_OWNER ||
    labels[MANAGED_LABELS.kind] !== spec.kind
  ) {
    throw new Error('Resource is not a managed devbox resource.');
  }
}
