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

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

function joinUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function withQuery(path: string, query?: RequestOptions['query']): string {
  if (!query) {
    return path;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const q = params.toString();
  return q.length === 0 ? path : `${path}?${q}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  return (await response.json()) as T;
}

async function* parseSse<T>(response: Response): AsyncIterable<SseEvent<T>> {
  if (!response.ok) {
    throw new Error(`Failed SSE request: ${response.status}`);
  }
  if (!response.body) {
    throw new Error('SSE response body is missing');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split('\n\n');
    buffer = messages.pop() ?? '';

    for (const msg of messages) {
      const eventLine = msg
        .split('\n')
        .find((line) => line.startsWith('event:'))
        ?.slice('event:'.length)
        .trim();
      const dataLine = msg
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice('data:'.length)
        .trim();

      if (!eventLine || !dataLine) {
        continue;
      }

      yield {
        event: eventLine,
        data: JSON.parse(dataLine) as T
      };
    }
  }
}

export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(path: string, req?: RequestOptions): Promise<T> {
    const response = await fetchImpl(joinUrl(options.baseUrl, withQuery(path, req?.query)), {
      method: req?.method ?? 'GET',
      headers: {
        'content-type': 'application/json'
      },
      body: req?.body ? JSON.stringify(req.body) : undefined
    });

    return parseResponse<T>(response);
  }

  async function sse<T>(path: string, query?: RequestOptions['query']): Promise<AsyncIterable<SseEvent<T>>> {
    const response = await fetchImpl(joinUrl(options.baseUrl, withQuery(path, query)), {
      headers: {
        accept: 'text/event-stream'
      }
    });
    return parseSse<T>(response);
  }

  return {
    createBox(input: CreateBoxInput): Promise<{ box: Box; job: Job }> {
      return request('/v1/boxes', {
        method: 'POST',
        body: input
      });
    },

    listBoxes(): Promise<Box[]> {
      return request('/v1/boxes');
    },

    getBox(boxId: string): Promise<Box> {
      return request(`/v1/boxes/${boxId}`);
    },

    stopBox(boxId: string): Promise<Job> {
      return request(`/v1/boxes/${boxId}/stop`, {
        method: 'POST'
      });
    },

    removeBox(boxId: string): Promise<Job> {
      return request(`/v1/boxes/${boxId}`, {
        method: 'DELETE'
      });
    },

    listJobs(): Promise<Job[]> {
      return request('/v1/jobs');
    },

    getJob(jobId: string): Promise<Job> {
      return request(`/v1/jobs/${jobId}`);
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
