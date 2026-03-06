import type {
  ContainerDetails,
  ContainerDevice,
  ContainerMount,
  CreateBoxContainerOptions
} from './runtime.js';

export const BOX_WORKSPACE_MOUNT_TARGET = '/workspace';
export const BOX_TUN_DEVICE: ContainerDevice = {
  PathOnHost: '/dev/net/tun',
  PathInContainer: '/dev/net/tun',
  CgroupPermissions: 'rwm'
};
export const BOX_CAP_ADD = ['NET_ADMIN', 'NET_RAW'] as const;

export interface BoxContainerCreateRequest {
  name: string;
  Image: string;
  Cmd?: string[];
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: {
    Mounts: Array<{
      Type: 'volume';
      Source: string;
      Target: typeof BOX_WORKSPACE_MOUNT_TARGET;
      ReadOnly: false;
    }>;
    NetworkMode: string;
    Devices: ContainerDevice[];
    CapAdd: string[];
    Privileged: false;
  };
}

export function buildBoxContainerCreateRequest(
  options: CreateBoxContainerOptions
): BoxContainerCreateRequest {
  return {
    name: options.name,
    Image: options.image,
    Cmd: options.command,
    Env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
    Labels: options.labels,
    HostConfig: {
      Mounts: [
        {
          Type: 'volume',
          Source: options.volumeName,
          Target: BOX_WORKSPACE_MOUNT_TARGET,
          ReadOnly: false
        }
      ],
      NetworkMode: options.networkName,
      Devices: [BOX_TUN_DEVICE],
      CapAdd: [...BOX_CAP_ADD],
      Privileged: false
    }
  };
}

function normalizeMount(mount: ContainerMount): ContainerMount {
  return {
    type: mount.type,
    source: mount.source ?? null,
    target: mount.target ?? null,
    readOnly: mount.readOnly
  };
}

function deviceKey(device: ContainerDevice): string {
  return [device.PathOnHost, device.PathInContainer, device.CgroupPermissions].join('|');
}

function isDockerControlPlaneMount(mount: ContainerMount): boolean {
  const source = (mount.source ?? '').toLowerCase();
  const target = (mount.target ?? '').toLowerCase();
  return source.includes('docker.sock') || target.includes('docker.sock');
}

export function validateBoxContainerIsolation(
  details: ContainerDetails,
  expectedNetworkName: string
): string[] {
  const violations: string[] = [];
  const attachedNetworks = [...details.attachedNetworks].sort();
  const devices = [...details.devices].map(deviceKey).sort();
  const allowedDevices = [BOX_TUN_DEVICE].map(deviceKey).sort();
  const capAdd = [...details.capAdd].sort();
  const allowedCaps = [...BOX_CAP_ADD].sort();
  const mounts = details.mounts.map(normalizeMount);

  if (details.networkMode === 'host') {
    violations.push('uses host networking');
  }

  if (details.networkMode !== expectedNetworkName) {
    violations.push(`uses unexpected network mode ${details.networkMode ?? '<none>'}`);
  }

  if (attachedNetworks.length !== 1 || attachedNetworks[0] !== expectedNetworkName) {
    violations.push(
      `is attached to unexpected Docker networks (${attachedNetworks.join(', ') || '<none>'})`
    );
  }

  if (details.publishedPorts.length > 0) {
    violations.push('publishes Docker host ports');
  }

  if (details.exposedPorts.length > 0) {
    violations.push('declares Docker exposed ports');
  }

  const nonWorkspaceMounts = mounts.filter(
    (mount) =>
      !(
        mount.type === 'volume' &&
        mount.target === BOX_WORKSPACE_MOUNT_TARGET &&
        mount.readOnly === false
      )
  );
  if (nonWorkspaceMounts.length > 0) {
    violations.push('uses unexpected mounts');
  }

  if (mounts.some(isDockerControlPlaneMount)) {
    violations.push('mounts docker control-plane sockets');
  }

  if (JSON.stringify(devices) !== JSON.stringify(allowedDevices)) {
    violations.push('uses unexpected host devices');
  }

  if (JSON.stringify(capAdd) !== JSON.stringify(allowedCaps)) {
    violations.push('uses unexpected Linux capabilities');
  }

  if (details.privileged) {
    violations.push('runs as a privileged container');
  }

  return violations;
}
