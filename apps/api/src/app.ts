import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { DevboxOrchestrator } from '@devbox/orchestrator/orchestrator';
import { ConfigLockedError, NotFoundError, SecurityError, SetupRequiredError, ValidationError } from '@devbox/orchestrator/errors';

import {
  BoxIdParamsSchema,
  BoxLogsQuerySchema,
  BoxSchema,
  CreateBoxBodySchema,
  CreateBoxResponseSchema,
  JobIdParamsSchema,
  JobSchema,
  TailnetConfigBodySchema,
  TailnetConfigSchema
} from './schemas.js';

interface BuildAppOptions {
  orchestrator?: DevboxOrchestrator;
  heartbeatMs?: number;
  corsOrigin?: string;
}

function writeSseEvent(reply: FastifyReply, event: string, payload: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function attachErrorMapping(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const hasSchemaValidation =
      'validation' in error &&
      Array.isArray((error as FastifyError & { validation?: unknown[] }).validation);
    if (hasSchemaValidation || error.statusCode === 400) {
      reply.status(400).send({ message: error.message });
      return;
    }

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

    if (error instanceof ConfigLockedError) {
      reply.status(409).send({ message: error.message, boxCount: error.boxCount });
      return;
    }

    if (error instanceof SetupRequiredError) {
      reply.status(400).send({ message: error.message });
      return;
    }

    reply.status(500).send({ message: 'Internal server error' });
  });
}

export async function buildApp(options?: BuildAppOptions) {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        removeAdditional: false
      }
    }
  }).withTypeProvider<TypeBoxTypeProvider>();
  let orchestrator = options?.orchestrator;
  if (!orchestrator) {
    const { createOrchestrator } = await import('@devbox/orchestrator/factory');
    orchestrator = createOrchestrator();
  }
  await orchestrator.startRuntimeStatusMonitor();
  const heartbeatMs = options?.heartbeatMs ?? 15_000;
  const corsOrigin = options?.corsOrigin ?? process.env.DEVBOX_WEB_ORIGIN ?? 'http://localhost:5173';

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', corsOrigin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type,Accept,Authorization');

    if (request.method === 'OPTIONS') {
      await reply.status(204).send();
    }
  });

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
  app.addSchema(TailnetConfigSchema);

  attachErrorMapping(app);

  app.get('/openapi.json', async () => app.swagger());

  app.post(
    '/v1/boxes',
    {
      schema: {
        body: CreateBoxBodySchema,
        response: {
          200: CreateBoxResponseSchema
        }
      }
    },
    async (request) => orchestrator.createBox(request.body)
  );

  app.get(
    '/v1/boxes',
    {
      schema: {
        response: {
          200: Type.Array(Type.Ref(BoxSchema))
        }
      }
    },
    async () => orchestrator.listBoxes()
  );

  app.get(
    '/v1/boxes/:boxId',
    {
      schema: {
        params: BoxIdParamsSchema,
        response: {
          200: Type.Ref(BoxSchema)
        }
      }
    },
    async (request) => {
      const box = await orchestrator.getBox(request.params.boxId);
      if (!box) {
        throw new NotFoundError('Box not found');
      }
      return box;
    }
  );

  app.post(
    '/v1/boxes/:boxId/start',
    {
      schema: {
        params: BoxIdParamsSchema,
        response: {
          200: Type.Ref(JobSchema)
        }
      }
    },
    async (request) => orchestrator.startBox(request.params.boxId)
  );

  app.post(
    '/v1/boxes/:boxId/stop',
    {
      schema: {
        params: BoxIdParamsSchema,
        response: {
          200: Type.Ref(JobSchema)
        }
      }
    },
    async (request) => orchestrator.stopBox(request.params.boxId)
  );

  app.delete(
    '/v1/boxes/:boxId',
    {
      schema: {
        params: BoxIdParamsSchema,
        response: {
          200: Type.Ref(JobSchema)
        }
      }
    },
    async (request) => orchestrator.removeBox(request.params.boxId)
  );

  app.get(
    '/v1/boxes/:boxId/logs',
    {
      schema: {
        params: BoxIdParamsSchema,
        querystring: BoxLogsQuerySchema
      }
    },
    async (request, reply) => {
      const logs = await orchestrator.streamBoxLogs(request.params.boxId, {
        follow: request.query.follow,
        since: request.query.since,
        tail: request.query.tail
      });

      reply.hijack();
      reply.raw.setHeader('Access-Control-Allow-Origin', corsOrigin);
      reply.raw.setHeader('Vary', 'Origin');
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      for await (const log of logs) {
        writeSseEvent(reply, 'box.logs', log);
      }

      reply.raw.end();
      return reply;
    }
  );

  app.get(
    '/v1/jobs',
    {
      schema: {
        response: {
          200: Type.Array(Type.Ref(JobSchema))
        }
      }
    },
    async () => orchestrator.listJobs()
  );

  app.get(
    '/v1/jobs/:jobId',
    {
      schema: {
        params: JobIdParamsSchema,
        response: {
          200: Type.Ref(JobSchema)
        }
      }
    },
    async (request) => {
      const job = await orchestrator.getJob(request.params.jobId);
      if (!job) {
        throw new NotFoundError('Job not found');
      }
      return job;
    }
  );

  app.get(
    '/v1/tailnet/config',
    {
      schema: {
        response: {
          200: Type.Ref(TailnetConfigSchema)
        }
      }
    },
    async () => {
      const config = await orchestrator.getTailnetConfig();
      if (!config) {
        throw new NotFoundError('Tailnet config not set');
      }
      return config;
    }
  );

  app.put(
    '/v1/tailnet/config',
    {
      schema: {
        body: TailnetConfigBodySchema,
        response: {
          200: Type.Ref(TailnetConfigSchema)
        }
      }
    },
    async (request) => orchestrator.setTailnetConfig(request.body)
  );

  app.delete(
    '/v1/tailnet/config',
    async () => {
      await orchestrator.deleteTailnetConfig();
      return { message: 'Tailnet config deleted' };
    }
  );

  app.get('/v1/events', async (_request, reply) => {
    reply.hijack();
    reply.raw.setHeader('Access-Control-Allow-Origin', corsOrigin);
    reply.raw.setHeader('Vary', 'Origin');
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

  app.addHook('onClose', async () => {
    await orchestrator.stopRuntimeStatusMonitor();
  });

  return app;
}
