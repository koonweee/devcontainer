import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { buildInMemoryHarness, buildInMemoryOrchestrator } from './support/orchestrator.js';

async function waitForTerminalJob(app: Awaited<ReturnType<typeof buildApp>>, jobId: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}`
    });
    const job = response.json() as { status: string };
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

describe('API routes', () => {
  it('applies CORS headers and handles preflight requests', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator() });

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/boxes',
      headers: {
        origin: 'http://localhost:4173',
        'access-control-request-method': 'POST'
      }
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:4173');
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');

    const getBoxes = await app.inject({ method: 'GET', url: '/v1/boxes' });
    expect(getBoxes.headers['access-control-allow-origin']).toBe('http://localhost:4173');
    await app.close();
  });

  it('supports create/stop/remove and job status endpoints', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator(), heartbeatMs: 50 });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'api-test-box',
        image: 'debian:trixie-slim'
      }
    });

    expect(createRes.statusCode).toBe(200);
    const created = createRes.json() as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const getBox = await app.inject({ method: 'GET', url: `/v1/boxes/${created.box.id}` });
    expect(getBox.statusCode).toBe(200);

    const stopRes = await app.inject({ method: 'POST', url: `/v1/boxes/${created.box.id}/stop` });
    expect(stopRes.statusCode).toBe(200);
    const stopJob = stopRes.json() as { id: string };
    await waitForTerminalJob(app, stopJob.id);

    const removeRes = await app.inject({ method: 'DELETE', url: `/v1/boxes/${created.box.id}` });
    expect(removeRes.statusCode).toBe(200);
    const removeJob = removeRes.json() as { id: string };
    await waitForTerminalJob(app, removeJob.id);

    const jobsRes = await app.inject({ method: 'GET', url: '/v1/jobs' });
    expect(jobsRes.statusCode).toBe(200);
    expect((jobsRes.json() as unknown[]).length).toBeGreaterThanOrEqual(3);

    await app.close();
  });

  it('returns validation errors on invalid payloads', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator() });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'Invalid Name',
        image: 'debian:trixie-slim'
      }
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('emits job, box, and heartbeat events over SSE', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator(), heartbeatMs: 50 });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    const eventResponse = await fetch(`${address}/v1/events`);
    if (!eventResponse.body) {
      throw new Error('Expected event stream body');
    }

    const reader = eventResponse.body.getReader();
    const decoder = new TextDecoder();

    const createPromise = fetch(`${address}/v1/boxes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ name: 'sse-box', image: 'debian:trixie-slim' })
    });

    let payload = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out reading SSE')), 500))
      ]);

      payload += decoder.decode(read.value ?? new Uint8Array(), { stream: true });
      if (
        payload.includes('event: job.updated') &&
        payload.includes('event: box.updated') &&
        payload.includes('event: heartbeat')
      ) {
        break;
      }
      if (read.done) {
        break;
      }
    }

    expect(payload).toContain('event: job.updated');
    expect(payload).toContain('event: box.updated');
    expect(payload).toContain('event: heartbeat');

    await createPromise;
    reader.cancel().catch(() => undefined);
    await app.close();
  });

  it('returns 404 for missing box log streams before hijacking SSE', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator() });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/boxes/missing-box/logs'
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect((response.json() as { message: string }).message).toContain('Box not found');
    await app.close();
  });

  it('returns 400 when requesting logs before a container exists', async () => {
    const harness = buildInMemoryHarness();
    harness.runtime.failOn.createContainer = new Error('create container failed');
    const app = await buildApp({ orchestrator: harness.orchestrator });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'no-container-box',
        image: 'debian:trixie-slim'
      }
    });
    const created = createRes.json() as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/boxes/${created.box.id}/logs`
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('no container logs yet');
    await app.close();
  });

  it('returns 403 when requesting logs from unmanaged containers', async () => {
    const harness = buildInMemoryHarness();
    const app = await buildApp({ orchestrator: harness.orchestrator });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'unmanaged-logs-box',
        image: 'debian:trixie-slim'
      }
    });
    const created = createRes.json() as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const box = await harness.orchestrator.getBox(created.box.id);
    if (!box?.containerId) {
      throw new Error('Expected container id for unmanaged logs test');
    }
    const container = harness.runtime.containers.get(box.containerId);
    if (!container) {
      throw new Error('Expected container record for unmanaged logs test');
    }
    container.labels = {};

    const response = await app.inject({
      method: 'GET',
      url: `/v1/boxes/${created.box.id}/logs`
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { message: string }).message).toContain('unmanaged container');
    await app.close();
  });
});
