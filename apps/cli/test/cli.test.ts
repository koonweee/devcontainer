import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Box, type BoxLogsEvent, type Job, type TailnetConfig } from '@devbox/api-client';

import { buildCliProgram, parsePositiveIntegerOption, type CliApiClient } from '../src/cli.js';

function makeBox(overrides: Partial<Box> = {}): Box {
  return {
    id: 'box-1',
    name: 'box-one',
    image: 'runtime:test',
    status: 'running',
    containerId: 'container-1',
    networkName: 'net-1',
    volumeName: 'vol-1',
    tailnetUrl: null,
    tailnetDeviceId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ...overrides
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'create',
    status: 'queued',
    boxId: 'box-1',
    progress: 0,
    message: 'queued',
    error: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    startedAt: null,
    finishedAt: null,
    ...overrides
  };
}

function buildClient(overrides: Partial<CliApiClient> = {}): CliApiClient {
  return {
    async createBox() {
      return { box: makeBox(), job: makeJob() };
    },
    async listBoxes() {
      return [makeBox()];
    },
    async startBox() {
      return makeJob({ type: 'start' });
    },
    async stopBox() {
      return makeJob({ type: 'stop' });
    },
    async removeBox() {
      return makeJob({ type: 'remove' });
    },
    async streamBoxLogs() {
      async function* logs(): AsyncIterable<BoxLogsEvent> {
        yield {
          event: 'box.logs',
          data: {
            boxId: 'box-1',
            stream: 'stdout',
            line: 'hello',
            timestamp: new Date('2026-01-01T00:00:01.000Z').toISOString()
          }
        };
      }
      return logs();
    },
    async getTailnetConfig(): Promise<TailnetConfig> {
      return {
        tailnet: 'example.com',
        oauthClientId: 'client-id',
        oauthClientSecret: '****',
        tagsCsv: 'tag:devbox',
        hostnamePrefix: 'devbox',
        authkeyExpirySeconds: 86400,
        createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        updatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString()
      };
    },
    async setTailnetConfig(): Promise<TailnetConfig> {
      return {
        tailnet: 'example.com',
        oauthClientId: 'client-id',
        oauthClientSecret: '****',
        tagsCsv: 'tag:devbox',
        hostnamePrefix: 'devbox',
        authkeyExpirySeconds: 86400,
        createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        updatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString()
      };
    },
    async deleteTailnetConfig(): Promise<void> {
      // no-op
    },
    ...overrides
  };
}

describe('CLI logs command', () => {
  it('forwards follow/since/tail options to API client', async () => {
    const streamBoxLogs = vi.fn(async () => {
      async function* logs(): AsyncIterable<BoxLogsEvent> {
        // no-op
      }
      return logs();
    });

    const client = buildClient({ streamBoxLogs });
    const program = buildCliProgram(client);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await program.parseAsync([
      'node',
      'devbox',
      'logs',
      'box-one',
      '-f',
      '--since',
      '2026-01-01T00:00:00.000Z',
      '--tail',
      '50'
    ]);

    expect(streamBoxLogs).toHaveBeenCalledWith(
      'box-1',
      expect.objectContaining({
        follow: true,
        since: '2026-01-01T00:00:00.000Z',
        tail: 50
      })
    );

    logSpy.mockRestore();
  });

  it('validates positive tail values', () => {
    expect(parsePositiveIntegerOption('--tail', '5')).toBe(5);
    expect(() => parsePositiveIntegerOption('--tail', '0')).toThrow(
      '--tail must be a positive integer'
    );
    expect(() => parsePositiveIntegerOption('--tail', '10abc')).toThrow(
      '--tail must be a positive integer'
    );
    expect(() => parsePositiveIntegerOption('--tail', '1e2')).toThrow(
      '--tail must be a positive integer'
    );
  });
});

describe('CLI setup lock messaging', () => {
  it('prints friendly lock error for setup tailnet when boxes exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const client = buildClient({
      async setTailnetConfig() {
        throw new ApiError(409, {
          message: 'Cannot modify tailnet config while 1 boxes exist',
          boxCount: 1
        });
      }
    });
    const program = buildCliProgram(client);

    // process.exit is mocked so the throw after it will propagate
    await program.parseAsync([
      'node', 'devbox', 'setup', 'tailnet',
      '--tailnet', 'example.com',
      '--client-id', 'id',
      '--client-secret', 'secret'
    ]).catch(() => {/* expected re-throw */});

    expect(errorSpy).toHaveBeenCalledWith(
      'Error: Cannot modify tailnet config while 1 boxes exist. Remove all boxes first.'
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('prints friendly lock error for setup clear when boxes exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const client = buildClient({
      async deleteTailnetConfig() {
        throw new ApiError(409, {
          message: 'Cannot delete tailnet config while 2 boxes exist',
          boxCount: 2
        });
      }
    });
    const program = buildCliProgram(client);

    await program.parseAsync(['node', 'devbox', 'setup', 'clear']).catch(() => {/* expected re-throw */});

    expect(errorSpy).toHaveBeenCalledWith(
      'Error: Cannot modify tailnet config while 2 boxes exist. Remove all boxes first.'
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});
