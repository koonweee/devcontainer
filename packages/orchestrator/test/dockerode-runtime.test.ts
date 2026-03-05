import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type Dockerode from 'dockerode';

import { DockerodeRuntime } from '../src/dockerode-runtime.js';

describe('DockerodeRuntime', () => {
  it('fails with actionable message when runtime image is missing locally', async () => {
    const createContainer = vi.fn();
    const inspect = vi.fn().mockRejectedValue({ statusCode: 404 });
    const runtime = new DockerodeRuntime({
      getImage: vi.fn().mockReturnValue({ inspect }),
      createContainer
    } as unknown as Dockerode);

    await expect(
      runtime.createContainer({
        name: 'devbox-1',
        image: 'devbox-runtime:local',
        networkName: 'net',
        volumeName: 'vol',
        labels: {}
      })
    ).rejects.toThrow('Runtime image not found locally: devbox-runtime:local');
    expect(createContainer).not.toHaveBeenCalled();
  });

  it('creates container when runtime image is already present locally', async () => {
    const inspect = vi.fn().mockResolvedValue({});
    const createContainer = vi.fn().mockResolvedValue({ id: 'container-123' });
    const runtime = new DockerodeRuntime({
      getImage: vi.fn().mockReturnValue({ inspect }),
      createContainer
    } as unknown as Dockerode);

    const id = await runtime.createContainer({
      name: 'devbox-2',
      image: 'runtime:test',
      networkName: 'net',
      volumeName: 'vol',
      labels: { one: '1' },
      command: ['sleep', 'infinity'],
      env: { HELLO: 'world' }
    });

    expect(id).toBe('container-123');
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'devbox-2',
        Image: 'runtime:test'
      })
    );
  });

  it('streams container runtime events with managed filters', async () => {
    const eventsStream = Readable.from([
      '{"Type":"container","Action":"start","time":1700000000,"Actor":{"ID":"container-1","Attributes":{"com.devbox.managed":"true","com.devbox.box_id":"box-1","com.devbox.owner":"orchestrator"}}}\n'
    ]);
    const getEvents = vi.fn().mockResolvedValue(eventsStream);
    const runtime = new DockerodeRuntime({
      getEvents
    } as unknown as Dockerode);

    const received = [];
    for await (const event of runtime.streamContainerEvents()) {
      received.push(event);
    }

    expect(received).toEqual([
      {
        containerId: 'container-1',
        action: 'start',
        labels: {
          'com.devbox.managed': 'true',
          'com.devbox.box_id': 'box-1',
          'com.devbox.owner': 'orchestrator'
        },
        timestamp: new Date(1_700_000_000_000).toISOString()
      }
    ]);
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          type: ['container'],
          label: ['com.devbox.managed=true', 'com.devbox.owner=orchestrator']
        }
      })
    );
  });

  it('passes tail and since options when requesting container logs', async () => {
    const logs = vi
      .fn()
      .mockResolvedValue('2026-03-01T00:00:00.000000001Z hello from docker\n');
    const runtime = new DockerodeRuntime({
      getContainer: vi.fn().mockReturnValue({ logs }),
      modem: { demuxStream: vi.fn() }
    } as unknown as Dockerode);

    const received = [];
    for await (const event of runtime.streamContainerLogs('container-logs', {
      follow: false,
      since: '2026-03-01T00:00:00.000Z',
      tail: 42
    })) {
      received.push(event);
    }

    expect(received).toHaveLength(1);
    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({
        follow: false,
        stdout: true,
        stderr: true,
        timestamps: true,
        since: Math.floor(new Date('2026-03-01T00:00:00.000Z').getTime() / 1000),
        tail: 42
      })
    );
  });

  it('filters out log lines at or before since cursor', async () => {
    const logs = vi.fn().mockResolvedValue(
      [
        '2026-03-01T00:00:00.400000000Z old line',
        '2026-03-01T00:00:00.500000000Z duplicate line',
        '2026-03-01T00:00:00.500000001Z new line'
      ].join('\n')
    );
    const runtime = new DockerodeRuntime({
      getContainer: vi.fn().mockReturnValue({ logs }),
      modem: { demuxStream: vi.fn() }
    } as unknown as Dockerode);

    const received = [];
    for await (const event of runtime.streamContainerLogs('container-logs', {
      follow: true,
      since: '2026-03-01T00:00:00.500000000Z'
    })) {
      received.push(event);
    }

    expect(received).toEqual([
      {
        stream: 'stdout',
        timestamp: '2026-03-01T00:00:00.500000001Z',
        line: 'new line'
      }
    ]);
    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({
        since: Math.floor(new Date('2026-03-01T00:00:00.500000000Z').getTime() / 1000),
        follow: true
      })
    );
  });

  it('parses multiplexed non-follow buffer logs into stdout and stderr lines', async () => {
    const stdoutPayload = '2026-03-01T00:00:00.000000000Z out line\n';
    const stderrPayload = '2026-03-01T00:00:01.000000000Z err line\n';
    const stdout = Buffer.from(stdoutPayload, 'utf8');
    const stderr = Buffer.from(stderrPayload, 'utf8');

    const stdoutHeader = Buffer.alloc(8);
    stdoutHeader[0] = 1;
    stdoutHeader.writeUInt32BE(stdout.length, 4);

    const stderrHeader = Buffer.alloc(8);
    stderrHeader[0] = 2;
    stderrHeader.writeUInt32BE(stderr.length, 4);

    const logs = vi.fn().mockResolvedValue(Buffer.concat([stdoutHeader, stdout, stderrHeader, stderr]));
    const runtime = new DockerodeRuntime({
      getContainer: vi.fn().mockReturnValue({ logs }),
      modem: { demuxStream: vi.fn() }
    } as unknown as Dockerode);

    const received = [];
    for await (const event of runtime.streamContainerLogs('container-logs', { follow: false })) {
      received.push(event);
    }

    expect(received).toEqual([
      {
        stream: 'stdout',
        timestamp: '2026-03-01T00:00:00.000000000Z',
        line: 'out line'
      },
      {
        stream: 'stderr',
        timestamp: '2026-03-01T00:00:01.000000000Z',
        line: 'err line'
      }
    ]);
  });
});
