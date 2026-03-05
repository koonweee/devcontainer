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

  private keyCounter = 0;

  async mintAuthKey(config: TailnetConfig): Promise<TailscaleAuthKey> {
    this.calls.push({ method: 'mintAuthKey', args: [config] });
    if (this.failOn.mintAuthKey) {
      throw this.failOn.mintAuthKey;
    }
    this.keyCounter += 1;
    return { ...this.mintKeyResult, id: `${this.mintKeyResult.id}-${this.keyCounter}` };
  }

  async listDevices(config: TailnetConfig): Promise<TailscaleDevice[]> {
    this.calls.push({ method: 'listDevices', args: [config] });
    if (this.failOn.listDevices) {
      throw this.failOn.listDevices;
    }
    return [...this.devices];
  }

  async deleteDevice(config: TailnetConfig, deviceId: string): Promise<void> {
    this.calls.push({ method: 'deleteDevice', args: [config, deviceId] });
    if (this.failOn.deleteDevice) {
      throw this.failOn.deleteDevice;
    }
    this.devices = this.devices.filter((d) => d.id !== deviceId);
  }
}
