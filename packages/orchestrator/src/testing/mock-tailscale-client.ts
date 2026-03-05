import type { TailscaleAuthKey, TailscaleClient, TailscaleDevice } from '../tailscale-client.js';
import type { TailnetConfig } from '../types.js';

interface RecordedCall {
  method: string;
  args: unknown[];
}

/** Records all calls and returns configurable results for tests. */
export class MockTailscaleClient implements TailscaleClient {
  readonly calls: RecordedCall[] = [];
  devices: TailscaleDevice[] = [];
  mintKeyResult: TailscaleAuthKey = { key: 'tskey-auth-mock', id: 'mock-key-id' };
  failOn: Partial<Record<keyof TailscaleClient, Error>> = {};
  autoCreateDeviceOnLookup = true;

  private keyCounter = 0;

  async mintAuthKey(config: TailnetConfig): Promise<TailscaleAuthKey> {
    this.calls.push({ method: 'mintAuthKey', args: [config] });
    if (this.failOn.mintAuthKey) {
      throw this.failOn.mintAuthKey;
    }
    this.keyCounter += 1;
    return { ...this.mintKeyResult, id: `${this.mintKeyResult.id}-${this.keyCounter}` };
  }

  async findDeviceByHostname(config: TailnetConfig, hostname: string): Promise<TailscaleDevice | null> {
    this.calls.push({ method: 'findDeviceByHostname', args: [config, hostname] });
    if (this.failOn.findDeviceByHostname) {
      throw this.failOn.findDeviceByHostname;
    }
    const existing = this.devices.find((d) => d.hostname === hostname);
    if (existing) {
      return existing;
    }
    if (!this.autoCreateDeviceOnLookup) {
      return null;
    }
    return {
      id: `device-${hostname}`,
      hostname,
      name: hostname
    };
  }

  async deleteDevice(config: TailnetConfig, deviceId: string): Promise<void> {
    this.calls.push({ method: 'deleteDevice', args: [config, deviceId] });
    if (this.failOn.deleteDevice) {
      throw this.failOn.deleteDevice;
    }
    this.devices = this.devices.filter((d) => d.id !== deviceId);
  }
}
