import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { InMemoryBoxRepository, InMemoryJobRepository, MockDockerRuntime, OrchestratorService } from '@devbox/orchestrator';

export const buildServer = () => {
  const app = Fastify();
  const orchestrator = new OrchestratorService(new MockDockerRuntime(), new InMemoryBoxRepository(), new InMemoryJobRepository());

  app.register(swagger, {
    openapi: {
      info: { title: 'Devbox API', version: '0.1.0' }
    }
  });

  app.get('/health', async () => ({ ok: true }));

  app.post('/v1/boxes', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'image'],
        properties: { name: { type: 'string' }, image: { type: 'string' } }
      }
    }
  }, async (req, reply) => {
    const body = req.body as { name: string; image: string };
    try {
      const result = await orchestrator.createBox(body);
      return reply.code(202).send(result);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get('/v1/boxes', async () => orchestrator.listBoxes());
  app.get('/v1/boxes/:boxId', async (req, reply) => {
    const box = await orchestrator.getBox((req.params as { boxId: string }).boxId);
    if (!box) return reply.code(404).send({ message: 'not found' });
    return box;
  });
  app.post('/v1/boxes/:boxId/stop', async (req, reply) => {
    try {
      const job = await orchestrator.stopBox((req.params as { boxId: string }).boxId);
      return reply.code(202).send(job);
    } catch {
      return reply.code(404).send({ message: 'not found' });
    }
  });
  app.delete('/v1/boxes/:boxId', async (req, reply) => {
    try {
      const job = await orchestrator.removeBox((req.params as { boxId: string }).boxId);
      return reply.code(202).send(job);
    } catch {
      return reply.code(404).send({ message: 'not found' });
    }
  });

  app.get('/v1/jobs', async () => orchestrator.listJobs());
  app.get('/v1/jobs/:jobId', async (req, reply) => {
    const job = await orchestrator.getJob((req.params as { jobId: string }).jobId);
    if (!job) return reply.code(404).send({ message: 'not found' });
    return job;
  });

  app.get('/v1/events', async (_req, reply) => {
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    const send = (type: string, payload: object) => reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    const onJob = (job: object) => send('job.updated', job);
    const onBox = (box: object) => send('box.updated', box);
    orchestrator.events().on('job.updated', onJob);
    orchestrator.events().on('box.updated', onBox);
    const timer = setInterval(() => send('heartbeat', { timestamp: new Date().toISOString() }), 15000);
    _req.raw.on('close', () => {
      clearInterval(timer);
      orchestrator.events().off('job.updated', onJob);
      orchestrator.events().off('box.updated', onBox);
    });
    return reply;
  });

  app.get('/v1/boxes/:boxId/logs', async (req, reply) => {
    reply.raw.setHeader('content-type', 'text/event-stream');
    const boxId = (req.params as { boxId: string }).boxId;
    for await (const line of orchestrator.streamBoxLogs(boxId)) {
      reply.raw.write(`event: box.logs\ndata: ${JSON.stringify(line)}\n\n`);
    }
    return reply;
  });

  return app;
};

if (process.env.NODE_ENV !== 'test') {
  const app = buildServer();
  app.listen({ port: 3000, host: '0.0.0.0' });
}
