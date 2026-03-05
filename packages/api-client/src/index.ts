import createClient from 'openapi-fetch';
import { parseServerSentEvents } from 'parse-sse';

import type { paths } from './generated.js';

export type Box =
  paths['/v1/boxes']['get']['responses'][200]['content']['application/json'][number];
export type Job = paths['/v1/jobs']['get']['responses'][200]['content']['application/json'][number];

export interface CreateBoxInput {
  name: string;
  command?: string[];
  env?: Record<string, string>;
}

export interface TailnetConfig {
  tailnet: string;
  oauthClientId: string;
  oauthClientSecret: string;
  tagsCsv: string;
  hostnamePrefix: string;
  authkeyExpirySeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface TailnetConfigInput {
  tailnet: string;
  oauthClientId: string;
  oauthClientSecret: string;
  tagsCsv?: string;
  hostnamePrefix?: string;
  authkeyExpirySeconds?: number;
}

export interface SseEvent<T = unknown> {
  event: string;
  data: T;
}

export interface ReadyEvent extends SseEvent<{ timestamp: string }> {
  event: 'ready';
}

export interface HeartbeatEvent extends SseEvent<{ timestamp: string }> {
  event: 'heartbeat';
}

export interface JobUpdatedEvent extends SseEvent<{ type: 'job.updated'; job: Job }> {
  event: 'job.updated';
}

export interface BoxUpdatedEvent extends SseEvent<{ type: 'box.updated'; box: Box }> {
  event: 'box.updated';
}

export interface BoxRemovedEvent extends SseEvent<{ type: 'box.removed'; boxId: string }> {
  event: 'box.removed';
}

export interface BoxLogEvent {
  boxId: string;
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: string;
}

export interface BoxLogsEvent extends SseEvent<BoxLogEvent> {
  event: 'box.logs';
}

export type ApiStreamEvent =
  | ReadyEvent
  | HeartbeatEvent
  | JobUpdatedEvent
  | BoxUpdatedEvent
  | BoxRemovedEvent;

export interface ApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    const payloadMessage =
      typeof payload === 'object' &&
      payload !== null &&
      'message' in payload &&
      typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : 'unknown';
    super(`API error ${status}: ${payloadMessage}`);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function getConfigLockedBoxCount(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null;
  }
  const boxCount = (error.payload as { boxCount?: unknown } | null)?.boxCount;
  return typeof boxCount === 'number' ? boxCount : null;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>
): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function parseResponsePayload(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    throw new ApiError(result.response.status, result.error ?? {});
  }

  return result.data;
}

async function* parseSse<TEvent extends SseEvent>(response: Response): AsyncIterable<TEvent> {
  if (!response.ok) {
    throw new Error(`Failed SSE request: ${response.status}`);
  }
  const stream = parseServerSentEvents(response);
  const reader = stream.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    yield {
      event: value.type,
      data: JSON.parse(value.data) as unknown
    } as TEvent;
  }
}

export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    fetch: fetchImpl
  });

  async function sse<TEvent extends SseEvent>(
    path: string,
    requestOptions?: {
      query?: Record<string, string | number | boolean | undefined>;
      signal?: AbortSignal;
    }
  ): Promise<AsyncIterable<TEvent>> {
    const response = await fetchImpl(buildUrl(options.baseUrl, path, requestOptions?.query), {
      headers: {
        accept: 'text/event-stream'
      },
      signal: requestOptions?.signal
    });
    return parseSse<TEvent>(response);
  }

  return {
    async createBox(input: CreateBoxInput): Promise<{ box: Box; job: Job }> {
      return unwrap(await client.POST('/v1/boxes', { body: input }));
    },

    async listBoxes(): Promise<Box[]> {
      return unwrap(await client.GET('/v1/boxes'));
    },

    async getBox(boxId: string): Promise<Box> {
      return unwrap(await client.GET('/v1/boxes/{boxId}', { params: { path: { boxId } } }));
    },

    async stopBox(boxId: string): Promise<Job> {
      return unwrap(await client.POST('/v1/boxes/{boxId}/stop', { params: { path: { boxId } } }));
    },

    async startBox(boxId: string): Promise<Job> {
      return unwrap(await client.POST('/v1/boxes/{boxId}/start', { params: { path: { boxId } } }));
    },

    async removeBox(boxId: string): Promise<Job> {
      return unwrap(await client.DELETE('/v1/boxes/{boxId}', { params: { path: { boxId } } }));
    },

    async listJobs(): Promise<Job[]> {
      return unwrap(await client.GET('/v1/jobs'));
    },

    async getJob(jobId: string): Promise<Job> {
      return unwrap(await client.GET('/v1/jobs/{jobId}', { params: { path: { jobId } } }));
    },

    async getTailnetConfig(): Promise<TailnetConfig> {
      const response = await fetchImpl(buildUrl(options.baseUrl, '/v1/tailnet/config'), {
        headers: { accept: 'application/json' }
      });
      if (response.status === 404) {
        throw new Error('Tailnet config not set');
      }
      if (!response.ok) {
        throw new Error(`API error ${response.status}`);
      }
      return (await response.json()) as TailnetConfig;
    },

    async setTailnetConfig(input: TailnetConfigInput): Promise<TailnetConfig> {
      const response = await fetchImpl(buildUrl(options.baseUrl, '/v1/tailnet/config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input)
      });
      if (!response.ok) {
        throw new ApiError(response.status, await parseResponsePayload(response));
      }
      return (await response.json()) as TailnetConfig;
    },

    async deleteTailnetConfig(): Promise<void> {
      const response = await fetchImpl(buildUrl(options.baseUrl, '/v1/tailnet/config'), {
        method: 'DELETE'
      });
      if (!response.ok) {
        throw new ApiError(response.status, await parseResponsePayload(response));
      }
    },

    streamEvents(options?: { signal?: AbortSignal }): Promise<AsyncIterable<ApiStreamEvent>> {
      return sse<ApiStreamEvent>('/v1/events', options);
    },

    streamBoxLogs(
      boxId: string,
      options?: { follow?: boolean; since?: string; tail?: number; signal?: AbortSignal }
    ): Promise<AsyncIterable<BoxLogsEvent>> {
      const query = options
        ? {
            follow: options.follow,
            since: options.since,
            tail: options.tail
          }
        : undefined;
      return sse<BoxLogsEvent>(`/v1/boxes/${boxId}/logs`, {
        query,
        signal: options?.signal
      });
    }
  };
}
