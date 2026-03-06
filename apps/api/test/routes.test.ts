import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { buildInMemoryHarness, buildInMemoryOrchestrator } from './support/orchestrator.js';

async function waitForTerminalJob(app: Awaited<ReturnType<typeof buildApp>>, jobId: string): Promise<void> {
  const deadline = Date.now() + 5000;
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
    const app = await buildApp({
      orchestrator: buildInMemoryOrchestrator(),
      corsOrigin: 'http://localhost:4173,http://localhost:5173'
    });

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/boxes',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST'
      }
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');

    const preflight4173 = await app.inject({
      method: 'OPTIONS',
      url: '/v1/boxes',
      headers: {
        origin: 'http://localhost:4173',
        'access-control-request-method': 'POST'
      }
    });
    expect(preflight4173.statusCode).toBe(204);
    expect(preflight4173.headers['access-control-allow-origin']).toBe('http://localhost:4173');

    const getBoxes = await app.inject({
      method: 'GET',
      url: '/v1/boxes',
      headers: {
        origin: 'http://localhost:4173'
      }
    });
    expect(getBoxes.headers['access-control-allow-origin']).toBe('http://localhost:4173');
    await app.close();
  });

  it('rejects disallowed origins instead of sending a fallback CORS origin', async () => {
    const app = await buildApp({
      orchestrator: buildInMemoryOrchestrator(),
      corsOrigin: 'http://localhost:4173,http://localhost:5173'
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/boxes',
      headers: {
        origin: 'http://malicious.example'
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect((response.json() as { message: string }).message).toContain('Origin not allowed');
    await app.close();
  });

  it('supports create/start/stop/remove and job status endpoints', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator(), heartbeatMs: 50 });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'api-test-box'
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

    const startRes = await app.inject({ method: 'POST', url: `/v1/boxes/${created.box.id}/start` });
    expect(startRes.statusCode).toBe(200);
    const startJob = startRes.json() as { id: string };
    await waitForTerminalJob(app, startJob.id);

    const removeRes = await app.inject({ method: 'DELETE', url: `/v1/boxes/${created.box.id}` });
    expect(removeRes.statusCode).toBe(200);
    const removeJob = removeRes.json() as { id: string };
    await waitForTerminalJob(app, removeJob.id);

    const removedBox = await app.inject({ method: 'GET', url: `/v1/boxes/${created.box.id}` });
    expect(removedBox.statusCode).toBe(404);

    const jobsRes = await app.inject({ method: 'GET', url: '/v1/jobs' });
    expect(jobsRes.statusCode).toBe(200);
    expect((jobsRes.json() as unknown[]).length).toBeGreaterThanOrEqual(4);

    await app.close();
  });

  it('returns 400 when starting a box that is not stopped', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator() });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'start-invalid-box'
      }
    });
    expect(createRes.statusCode).toBe(200);

    const created = createRes.json() as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const startRes = await app.inject({ method: 'POST', url: `/v1/boxes/${created.box.id}/start` });
    expect(startRes.statusCode).toBe(400);
    expect((startRes.json() as { message: string }).message).toContain('Only stopped boxes');
    await app.close();
  });

  it('returns config lock payload with boxCount when boxes exist', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator() });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: { name: 'lock-payload-box' }
    });
    expect(createRes.statusCode).toBe(200);
    const created = createRes.json() as { job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const putRes = await app.inject({
      method: 'PUT',
      url: '/v1/tailnet/config',
      payload: {
        tailnet: 'example.com',
        oauthClientId: 'new-client',
        oauthClientSecret: 'new-secret'
      }
    });
    expect(putRes.statusCode).toBe(409);
    expect(putRes.json()).toMatchObject({
      message: expect.stringContaining('while 1 boxes exist'),
      boxCount: 1
    });

    await app.close();
  });

  it('reconciles stale runtime status on list and detail reads', async () => {
    const harness = buildInMemoryHarness();
    const app = await buildApp({ orchestrator: harness.orchestrator });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'reconcile-api-box'
      }
    });
    expect(createRes.statusCode).toBe(200);
    const created = createRes.json() as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const createdBox = harness.boxes.get(created.box.id);
    if (!createdBox?.containerId) {
      throw new Error('Expected container id for reconciliation route test');
    }

    harness.runtime.setContainerStatus(createdBox.containerId, 'exited');

    const listRes = await app.inject({ method: 'GET', url: '/v1/boxes' });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json() as Array<{ id: string; status: string }>;
    expect(listed.find((box) => box.id === created.box.id)?.status).toBe('stopped');

    const detailRes = await app.inject({ method: 'GET', url: `/v1/boxes/${created.box.id}` });
    expect(detailRes.statusCode).toBe(200);
    expect((detailRes.json() as { status: string }).status).toBe('stopped');

    await app.close();
  });

  it('returns validation errors on invalid payloads', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator() });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'Invalid Name'
      }
    });

    expect(response.statusCode).toBe(400);

    const legacyPayload = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'legacy-image-field',
        image: 'debian:trixie-slim'
      }
    });

    expect(legacyPayload.statusCode).toBe(400);
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
      body: JSON.stringify({ name: 'sse-box' })
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

  it('emits box.updated over SSE when runtime monitor reconciles external container changes', async () => {
    const harness = buildInMemoryHarness();
    const app = await buildApp({ orchestrator: harness.orchestrator, heartbeatMs: 50 });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'runtime-monitor-sse-box'
      }
    });
    const created = createRes.json() as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const box = harness.boxes.get(created.box.id);
    if (!box?.containerId) {
      throw new Error('Expected container id for runtime monitor SSE test');
    }

    const response = await fetch(`${address}/v1/events`);
    if (!response.body) {
      throw new Error('Expected SSE response body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    harness.runtime.setContainerStatus(box.containerId, 'exited');
    harness.runtime.emitContainerEvent({
      containerId: box.containerId,
      action: 'die',
      labels: {
        'com.devbox.managed': 'true',
        'com.devbox.box_id': box.id,
        'com.devbox.owner': 'orchestrator',
        'com.devbox.kind': 'container'
      },
      timestamp: new Date().toISOString()
    });

    let payload = '';
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timed out reading monitor SSE')), 500)
        )
      ]);

      payload += decoder.decode(read.value ?? new Uint8Array(), { stream: true });
      if (payload.includes('event: box.updated') && payload.includes('"status":"stopped"')) {
        break;
      }
      if (read.done) {
        break;
      }
    }

    expect(payload).toContain('event: box.updated');
    expect(payload).toContain('"status":"stopped"');

    reader.cancel().catch(() => undefined);
    await app.close();
  });

  it('emits box.removed over SSE when boxes are removed', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator(), heartbeatMs: 50 });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'sse-remove-box'
      }
    });
    const created = createRes.json() as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const response = await fetch(`${address}/v1/events`);
    if (!response.body) {
      throw new Error('Expected SSE response body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const removeRes = await fetch(`${address}/v1/boxes/${created.box.id}`, {
      method: 'DELETE'
    });
    const removeJob = (await removeRes.json()) as { id: string };
    await waitForTerminalJob(app, removeJob.id);

    let payload = '';
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out reading remove SSE')), 500))
      ]);

      payload += decoder.decode(read.value ?? new Uint8Array(), { stream: true });
      if (payload.includes('event: box.removed') && payload.includes(`"boxId":"${created.box.id}"`)) {
        break;
      }
      if (read.done) {
        break;
      }
    }

    expect(payload).toContain('event: box.removed');
    expect(payload).toContain(`"boxId":"${created.box.id}"`);

    reader.cancel().catch(() => undefined);
    await app.close();
  });

  it('emits starting and running box.updated events over SSE for start jobs', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator(), heartbeatMs: 50 });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    const createRes = await fetch(`${address}/v1/boxes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ name: 'sse-start-box' })
    });
    const created = (await createRes.json()) as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const stopRes = await fetch(`${address}/v1/boxes/${created.box.id}/stop`, {
      method: 'POST'
    });
    const stopJob = (await stopRes.json()) as { id: string };
    await waitForTerminalJob(app, stopJob.id);

    const response = await fetch(`${address}/v1/events`);
    if (!response.body) {
      throw new Error('Expected SSE response body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const startRes = await fetch(`${address}/v1/boxes/${created.box.id}/start`, {
      method: 'POST'
    });
    const startJob = (await startRes.json()) as { id: string };
    await waitForTerminalJob(app, startJob.id);

    let payload = '';
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out reading start SSE')), 500))
      ]);

      payload += decoder.decode(read.value ?? new Uint8Array(), { stream: true });
      if (payload.includes('"status":"starting"') && payload.includes('"status":"running"')) {
        break;
      }
      if (read.done) {
        break;
      }
    }

    expect(payload).toContain('event: box.updated');
    expect(payload).toContain('"status":"starting"');
    expect(payload).toContain('"status":"running"');

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

  it('streams box logs and forwards tail query options', async () => {
    const harness = buildInMemoryHarness();
    const app = await buildApp({ orchestrator: harness.orchestrator });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'tail-query-box'
      }
    });
    const created = createRes.json() as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const box = harness.boxes.get(created.box.id);
    if (!box?.containerId) {
      throw new Error('Expected container id for tail query test');
    }

    harness.runtime.pushLog(box.containerId, {
      stream: 'stdout',
      timestamp: new Date().toISOString(),
      line: 'tail line'
    });

    const response = await fetch(`${address}/v1/boxes/${created.box.id}/logs?tail=25`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('tail line');
    expect(harness.runtime.lastStreamContainerLogsOptions?.tail).toBe(25);

    await app.close();
  });

  it('aborts log follow streams when the client disconnects', async () => {
    const harness = buildInMemoryHarness();
    harness.runtime.holdFollowLogStreamOpen = true;
    const app = await buildApp({ orchestrator: harness.orchestrator });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'abort-log-stream-box'
      }
    });
    const created = createRes.json() as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);
    const box = harness.boxes.get(created.box.id);
    if (!box?.containerId) {
      throw new Error('Expected container id for abort test');
    }
    harness.runtime.pushLog(box.containerId, {
      stream: 'stdout',
      timestamp: new Date().toISOString(),
      line: 'ready'
    });

    const controller = new AbortController();
    const response = await fetch(`${address}/v1/boxes/${created.box.id}/logs?follow=true`, {
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
    controller.abort();

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && harness.runtime.logStreamAbortCount === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(harness.runtime.logStreamAbortCount).toBe(1);
    await app.close();
  });

  it('returns 400 when tail query is out of range', async () => {
    const app = await buildApp({ orchestrator: buildInMemoryOrchestrator() });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/boxes/missing-box/logs?tail=0'
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('must be >= 1');
    await app.close();
  });

  it('returns 404 when requesting logs for a box that failed creation and was compensated', async () => {
    const harness = buildInMemoryHarness();
    harness.runtime.failOn.createContainer = new Error('create container failed');
    const app = await buildApp({ orchestrator: harness.orchestrator });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'no-container-box'
      }
    });
    const created = createRes.json() as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/boxes/${created.box.id}/logs`
    });

    expect(response.statusCode).toBe(404);
    expect((response.json() as { message: string }).message).toContain('Box not found');
    await app.close();
  });

  it('returns 403 when requesting logs from unmanaged containers', async () => {
    const harness = buildInMemoryHarness();
    const app = await buildApp({ orchestrator: harness.orchestrator });

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/boxes',
      payload: {
        name: 'unmanaged-logs-box'
      }
    });
    const created = createRes.json() as { box: { id: string }; job: { id: string } };
    await waitForTerminalJob(app, created.job.id);

    const box = harness.boxes.get(created.box.id);
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
