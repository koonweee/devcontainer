import type { DockerRuntime, LogEvent } from './types.js';

export class MockDockerRuntime implements DockerRuntime {
  readonly calls: string[] = [];

  async createManagedResources(input: { boxId: string }): Promise<{ containerId: string }> {
    this.calls.push(`create:${input.boxId}`);
    return { containerId: `container-${input.boxId}` };
  }

  async stopManagedContainer(boxId: string): Promise<void> {
    this.calls.push(`stop:${boxId}`);
  }

  async removeManagedResources(boxId: string): Promise<void> {
    this.calls.push(`remove:${boxId}`);
  }

  async *streamLogs(boxId: string): AsyncIterable<LogEvent> {
    this.calls.push(`logs:${boxId}`);
    yield { timestamp: new Date().toISOString(), line: `${boxId}: booting` };
  }
}
