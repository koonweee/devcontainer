import Fastify from 'fastify';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import {
  InMemoryBoxRepository
} from '@devbox/orchestrator/in-memory-repositories';
import { InMemoryJobRepository } from '@devbox/orchestrator/in-memory-repositories';
import { JobRunner } from '@devbox/orchestrator/job-runner';
import { MockDockerRuntime } from '@devbox/orchestrator/mock-runtime';
import type { DevboxOrchestrator } from '@devbox/orchestrator/orchestrator';
import { DevboxOrchestrator as OrchestratorClass } from '@devbox/orchestrator/orchestrator';
import { NotFoundError, SecurityError, ValidationError } from '@devbox/orchestrator/errors';
import { OrchestratorEvents } from '@devbox/orchestrator/events';

import { BoxSchema, CreateBoxBodySchema, JobSchema } from './schemas.js';

interface BuildAppOptions {
  orchestrator?: DevboxOrchestrator;
  heartbeatMs?: number;
}

function writeSseEvent(reply: { raw: { write: (chunk: string) => void } }, event: string, payload: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function attachErrorMapping(app: ReturnType<typeof Fastify>): void {
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ValidationError) {
      reply.status(400).send({ message: error.message });
      return;
    }

    if (error instanceof NotFoundError) {
      reply.status(404).send({ message: error.message });
      return;
    }

    if (error instanceof SecurityError) {
      reply.status(403).send({ message: error.message });
      return;
    }

    reply.status(500).send({ message: 'Internal server error' });
  });
}

export function buildInMemoryOrchestrator(): DevboxOrchestrator {
  const events = new OrchestratorEvents();
  const jobs = new InMemoryJobRepository();
  const boxes = new InMemoryBoxRepository();
  const runner = new JobRunner(jobs, events);
  const runtime = new MockDockerRuntime();
  return new OrchestratorClass(runtime, boxes, jobs, runner, events);
}

export async function buildApp(options?: BuildAppOptions) {
  const app = Fastify({ logger: false });
  let orchestrator = options?.orchestrator;
  if (!orchestrator) {
    const { createOrchestrator } = await import('@devbox/orchestrator/factory');
    orchestrator = createOrchestrator();
  }
  const heartbeatMs = options?.heartbeatMs ?? 15_000;

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Devbox API',
        version: '0.1.0'
      }
    }
  });

  app.addSchema(BoxSchema);
  app.addSchema(JobSchema);

  attachErrorMapping(app);

  app.get('/openapi.json', async () => app.swagger());

  app.post('/v1/boxes', {
    schema: {
      body: CreateBoxBodySchema,
      response: {
        200: {
          type: 'object',
          required: ['box', 'job'],
          properties: {
            box: { $ref: 'Box#' },
            job: { $ref: 'Job#' }
          }
        }
      }
    }
  }, async (request) => {
    const body = request.body as {
      name: string;
      image: string;
      command?: string[];
      env?: Record<string, string>;
    };

    return orchestrator.createBox({
      name: body.name,
      image: body.image,
      command: body.command,
      env: body.env
    });
  });

  app.get('/v1/boxes', {
    schema: {
      response: {
        200: {
          type: 'array',
          items: { $ref: 'Box#' }
        }
      }
    }
  }, async () => orchestrator.listBoxes());

  app.get('/v1/boxes/:boxId', {
    schema: {
      params: {
        type: 'object',
        required: ['boxId'],
        properties: {
          boxId: { type: 'string' }
        }
      },
      response: {
        200: { $ref: 'Box#' }
      }
    }
  }, async (request) => {
    const box = await orchestrator.getBox((request.params as { boxId: string }).boxId);
    if (!box) {
      throw new NotFoundError('Box not found');
    }
    return box;
  });

  app.post('/v1/boxes/:boxId/stop', {
    schema: {
      params: {
        type: 'object',
        required: ['boxId'],
        properties: {
          boxId: { type: 'string' }
        }
      },
      response: {
        200: { $ref: 'Job#' }
      }
    }
  }, async (request) => orchestrator.stopBox((request.params as { boxId: string }).boxId));

  app.delete('/v1/boxes/:boxId', {
    schema: {
      params: {
        type: 'object',
        required: ['boxId'],
        properties: {
          boxId: { type: 'string' }
        }
      },
      response: {
        200: { $ref: 'Job#' }
      }
    }
  }, async (request) => orchestrator.removeBox((request.params as { boxId: string }).boxId));

  app.get('/v1/boxes/:boxId/logs', {
    schema: {
      params: {
        type: 'object',
        required: ['boxId'],
        properties: {
          boxId: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          follow: { type: 'boolean' },
          since: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { boxId } = request.params as { boxId: string };
    const query = request.query as { follow?: boolean; since?: string };

    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    for await (const log of orchestrator.streamBoxLogs(boxId, {
      follow: query.follow,
      since: query.since
    })) {
      writeSseEvent(reply, 'box.logs', log);
    }

    reply.raw.end();
    return reply;
  });

  app.get('/v1/jobs', {
    schema: {
      response: {
        200: {
          type: 'array',
          items: { $ref: 'Job#' }
        }
      }
    }
  }, async () => orchestrator.listJobs());

  app.get('/v1/jobs/:jobId', {
    schema: {
      params: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'string' }
        }
      },
      response: {
        200: { $ref: 'Job#' }
      }
    }
  }, async (request) => {
    const job = await orchestrator.getJob((request.params as { jobId: string }).jobId);
    if (!job) {
      throw new NotFoundError('Job not found');
    }
    return job;
  });

  app.get('/v1/events', async (_request, reply) => {
    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    writeSseEvent(reply, 'ready', { timestamp: new Date().toISOString() });

    const unsubscribe = orchestrator.events.subscribe((event) => {
      writeSseEvent(reply, event.type, event);
    });

    const heartbeat = setInterval(() => {
      writeSseEvent(reply, 'heartbeat', { timestamp: new Date().toISOString() });
    }, heartbeatMs);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
  });

  return app;
}
