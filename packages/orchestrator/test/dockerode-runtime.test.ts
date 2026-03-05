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
});
