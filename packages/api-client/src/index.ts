import createClient from 'openapi-fetch';
import { parseServerSentEvents } from 'parse-sse';

import type { paths } from './generated.js';

export type Box =
  paths['/v1/boxes']['get']['responses'][200]['content']['application/json'][number];
export type Job = paths['/v1/jobs']['get']['responses'][200]['content']['application/json'][number];

export interface CreateBoxInput {
  name: string;
  image: string;
  command?: string[];
  env?: Record<string, string>;
}

export interface SseEvent<T = unknown> {
  event: string;
  data: T;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
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

function formatOpenApiError(error: unknown): string {
  if (error === undefined) {
    return 'Unknown API error';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return 'API error (unserializable payload)';
    }
  }

  return String(error);
}

function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    const message = formatOpenApiError(result.error);
    throw new Error(`API error ${result.response.status}: ${message}`);
  }

  return result.data;
}

async function* parseSse<T>(response: Response): AsyncIterable<SseEvent<T>> {
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
      data: JSON.parse(value.data) as T
    };
  }
}

export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    fetch: fetchImpl
  });

  async function sse<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<AsyncIterable<SseEvent<T>>> {
    const response = await fetchImpl(buildUrl(options.baseUrl, path, query), {
      headers: {
        accept: 'text/event-stream'
      }
    });
    return parseSse<T>(response);
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

    async removeBox(boxId: string): Promise<Job> {
      return unwrap(await client.DELETE('/v1/boxes/{boxId}', { params: { path: { boxId } } }));
    },

    async listJobs(): Promise<Job[]> {
      return unwrap(await client.GET('/v1/jobs'));
    },

    async getJob(jobId: string): Promise<Job> {
      return unwrap(await client.GET('/v1/jobs/{jobId}', { params: { path: { jobId } } }));
    },

    streamEvents(): Promise<AsyncIterable<SseEvent>> {
      return sse('/v1/events');
    },

    streamBoxLogs(boxId: string, options?: { follow?: boolean; since?: string }): Promise<
      AsyncIterable<SseEvent>
    > {
      return sse(`/v1/boxes/${boxId}/logs`, options);
    }
  };
}
