import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('api routes', () => {
  it('supports create/stop/remove and jobs lookup', async () => {
    const app = buildServer();
    const create = await app.inject({ method: 'POST', url: '/v1/boxes', payload: { name: 'box-001', image: 'node:22' } });
    expect(create.statusCode).toBe(202);
    const body = create.json();
    expect(body.box.name).toBe('box-001');

    await new Promise((r) => setTimeout(r, 10));
    const stop = await app.inject({ method: 'POST', url: `/v1/boxes/${body.box.id}/stop` });
    expect(stop.statusCode).toBe(202);

    const rm = await app.inject({ method: 'DELETE', url: `/v1/boxes/${body.box.id}` });
    expect(rm.statusCode).toBe(202);

    const job = await app.inject({ method: 'GET', url: `/v1/jobs/${body.job.id}` });
    expect(job.statusCode).toBe(200);
    await app.close();
  });

  it('rejects invalid create payload', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'POST', url: '/v1/boxes', payload: { name: 'bad!', image: 'node' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
