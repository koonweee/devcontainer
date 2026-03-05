import { createParser } from 'eventsource-parser';

export interface ApiClientOptions { baseUrl: string; }

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.options.baseUrl}${path}`);
    if (!res.ok) throw new Error(`GET ${path} failed`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body?: unknown, method: 'POST' | 'DELETE' = 'POST'): Promise<T> {
    const res = await fetch(`${this.options.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw new Error(`${method} ${path} failed`);
    return res.json() as Promise<T>;
  }

  async *sse(path: string): AsyncIterable<{ event: string; data: string }> {
    const res = await fetch(`${this.options.baseUrl}${path}`);
    if (!res.body) return;
    const reader = res.body.getReader();
    const parser = createParser({
      onEvent: (event) => queue.push({ event: event.event || 'message', data: event.data })
    });
    const queue: Array<{ event: string; data: string }> = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(new TextDecoder().decode(value));
      while (queue.length > 0) yield queue.shift()!;
    }
  }
}
