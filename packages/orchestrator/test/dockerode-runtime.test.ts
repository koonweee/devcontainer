import { describe, expect, it, vi } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
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
      runtime.createBoxContainer({
        name: 'devbox-1',
        image: 'devbox-runtime:local',
        networkName: 'net',
        volumeName: 'vol',
        labels: {}
      })
    ).rejects.toThrow('Runtime image not found locally: devbox-runtime:local');
    expect(createContainer).not.toHaveBeenCalled();
  });

  it('builds the approved box container create payload', async () => {
    const inspect = vi.fn().mockResolvedValue({});
    const createContainer = vi.fn().mockResolvedValue({ id: 'container-123' });
    const runtime = new DockerodeRuntime({
      getImage: vi.fn().mockReturnValue({ inspect }),
      createContainer
    } as unknown as Dockerode);

    const id = await runtime.createBoxContainer({
      name: 'devbox-2',
      image: 'runtime:test',
      networkName: 'devbox-net-box',
      volumeName: 'workspace-vol',
      labels: { one: '1' },
      dnsServers: ['1.1.1.1', '1.0.0.1'],
      command: ['sleep', 'infinity'],
      env: { HELLO: 'world' }
    });

    expect(id).toBe('container-123');
    expect(createContainer).toHaveBeenCalledWith({
      name: 'devbox-2',
      Image: 'runtime:test',
      Cmd: ['sleep', 'infinity'],
      Env: ['HELLO=world'],
      Labels: { one: '1' },
      HostConfig: {
        Mounts: [
          {
            Type: 'volume',
            Source: 'workspace-vol',
            Target: '/workspace',
            ReadOnly: false
          }
        ],
        Dns: ['1.1.1.1', '1.0.0.1'],
        NetworkMode: 'devbox-net-box',
        Devices: [
          {
            PathOnHost: '/dev/net/tun',
            PathInContainer: '/dev/net/tun',
            CgroupPermissions: 'rwm'
          }
        ],
        CapAdd: ['NET_ADMIN', 'NET_RAW'],
        Privileged: false
      }
    });

    const request = createContainer.mock.calls[0][0];
    expect(request.ExposedPorts).toBeUndefined();
    expect(request.HostConfig.PortBindings).toBeUndefined();
    expect(request.HostConfig.PublishAllPorts).toBeUndefined();
    expect(request.HostConfig.Binds).toBeUndefined();
    expect(request.HostConfig.ExtraHosts).toBeUndefined();
    expect(request.HostConfig.Links).toBeUndefined();
    expect(request.HostConfig.PidMode).toBeUndefined();
    expect(request.HostConfig.IpcMode).toBeUndefined();
    expect(request.HostConfig.UTSMode).toBeUndefined();
  });

  it('maps inspect details needed for box isolation validation', async () => {
    const inspect = vi.fn().mockResolvedValue({
      Id: 'container-123',
      Config: {
        Labels: { one: '1' },
        ExposedPorts: {
          '8080/tcp': {}
        }
      },
      State: {
        Status: 'running'
      },
      HostConfig: {
        NetworkMode: 'net',
        Devices: [
          {
            PathOnHost: '/dev/net/tun',
            PathInContainer: '/dev/net/tun',
            CgroupPermissions: 'rwm'
          }
        ],
        CapAdd: ['NET_ADMIN', 'NET_RAW'],
        Privileged: false
      },
      NetworkSettings: {
        Networks: {
          net: {}
        },
        Ports: {
          '8080/tcp': [
            {
              HostIp: '0.0.0.0',
              HostPort: '3000'
            }
          ]
        }
      },
      Mounts: [
        {
          Type: 'volume',
          Source: 'vol',
          Destination: '/workspace',
          RW: true
        }
      ]
    });
    const runtime = new DockerodeRuntime({
      getContainer: vi.fn().mockReturnValue({ inspect })
    } as unknown as Dockerode);

    await expect(runtime.inspectContainer('container-123')).resolves.toEqual({
      id: 'container-123',
      labels: { one: '1' },
      status: 'running',
      networkMode: 'net',
      attachedNetworks: ['net'],
      publishedPorts: [{ containerPort: '8080/tcp', hostPort: '3000', hostIp: '0.0.0.0' }],
      exposedPorts: ['8080/tcp'],
      mounts: [{ type: 'volume', source: 'vol', target: '/workspace', readOnly: false }],
      devices: [
        {
          PathOnHost: '/dev/net/tun',
          PathInContainer: '/dev/net/tun',
          CgroupPermissions: 'rwm'
        }
      ],
      capAdd: ['NET_ADMIN', 'NET_RAW'],
      privileged: false
    });
  });

  it('streams container runtime events with managed filters', async () => {
    const eventsStream = Readable.from([
      '{"Type":"container","Action":"start","time":1700000000,"Actor":{"ID":"container-1","Attributes":{"com.devbox.managed":"true","com.devbox.box_id":"box-1","com.devbox.owner":"orchestrator","com.devbox.kind":"container"}}}\n'
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
          'com.devbox.owner': 'orchestrator',
          'com.devbox.kind': 'container'
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

  it('demuxes follow streams into stdout and stderr lines', async () => {
    const logStream = new PassThrough();
    const logs = vi.fn().mockResolvedValue(logStream);
    const demuxStream = vi.fn((_source, stdout: PassThrough, stderr: PassThrough) => {
      stdout.write('2026-03-01T00:00:00.000000000Z hello stdout\n');
      stderr.write('2026-03-01T00:00:01.000000000Z hello stderr\n');
      stdout.end();
      stderr.end();
      logStream.destroy();
    });
    const runtime = new DockerodeRuntime({
      getContainer: vi.fn().mockReturnValue({ logs }),
      modem: { demuxStream }
    } as unknown as Dockerode);

    const received = [];
    for await (const event of runtime.streamContainerLogs('container-follow', {
      follow: true
    })) {
      received.push(event);
    }

    expect(received).toEqual([
      {
        stream: 'stdout',
        timestamp: '2026-03-01T00:00:00.000000000Z',
        line: 'hello stdout'
      },
      {
        stream: 'stderr',
        timestamp: '2026-03-01T00:00:01.000000000Z',
        line: 'hello stderr'
      }
    ]);
    expect(demuxStream).toHaveBeenCalled();
  });

  it('aborts follow log streams by destroying the Docker stream', async () => {
    const raw = new PassThrough();
    const destroySpy = vi.spyOn(raw, 'destroy');
    const logs = vi.fn().mockResolvedValue(raw);
    const runtime = new DockerodeRuntime({
      getContainer: vi.fn().mockReturnValue({ logs }),
      modem: { demuxStream: vi.fn() }
    } as unknown as Dockerode);
    const controller = new AbortController();

    const consume = (async () => {
      for await (const _event of runtime.streamContainerLogs('container-logs', {
        follow: true,
        signal: controller.signal
      })) {
        // no-op
      }
    })();

    controller.abort();
    await consume;

    expect(destroySpy).toHaveBeenCalled();
  });
});
