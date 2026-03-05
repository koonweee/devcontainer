import { describe, expect, it } from 'vitest';

import { buildApp, buildInMemoryOrchestrator } from '../src/app.js';

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
});
