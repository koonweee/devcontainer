import { describe, expect, it, vi } from 'vitest';
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
});
