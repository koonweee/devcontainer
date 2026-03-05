import { describe, expect, it } from 'vitest';
import { InMemoryBoxRepository, InMemoryJobRepository, MockDockerRuntime, OrchestratorService } from '../src/index.js';

const setup = () => {
  const runtime = new MockDockerRuntime();
  const service = new OrchestratorService(runtime, new InMemoryBoxRepository(), new InMemoryJobRepository());
  return { runtime, service };
};

describe('OrchestratorService', () => {
  it('creates and transitions box state', async () => {
    const { service } = setup();
    const { box } = await service.createBox({ name: 'my-box', image: 'node:22' });
    await new Promise((r) => setTimeout(r, 10));
    const created = await service.getBox(box.id);
    expect(created?.status).toBe('running');
    const stopJob = await service.stopBox(box.id);
    expect(stopJob.type).toBe('stop');
    await new Promise((r) => setTimeout(r, 10));
    expect((await service.getBox(box.id))?.status).toBe('stopped');
  });

  it('rejects invalid inputs', async () => {
    const { service } = setup();
    await expect(service.createBox({ name: '??', image: 'node:22' })).rejects.toThrow('invalid name');
    await expect(service.createBox({ name: 'valid-name', image: 'node' })).rejects.toThrow('image must be tag-pinned');
  });
});
