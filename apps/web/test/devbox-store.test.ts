import { describe, expect, it, vi } from 'vitest';
import type { ApiStreamEvent, Box, BoxLogsEvent } from '@devbox/api-client';

import { createDevboxStore } from '../src/lib/devbox-store.js';

function makeBox(overrides: Partial<Box> = {}): Box {
  return {
    id: 'box-1',
    name: 'box-one',
    image: 'runtime:test',
    status: 'running',
    containerId: 'container-1',
    networkName: 'net-1',
    volumeName: 'vol-1',
    tailnetUrl: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ...overrides
  };
}

async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

async function* emptyEvents(): AsyncIterable<ApiStreamEvent> {
  // no-op
}

async function* emptyLogs(): AsyncIterable<BoxLogsEvent> {
  // no-op
}

describe('createDevboxStore', () => {
  it('applies box.updated events without list refresh per event', async () => {
    const initial = makeBox();
    const updated = makeBox({
      status: 'stopped',
      updatedAt: new Date('2026-01-01T00:00:10.000Z').toISOString()
    });

    let listBoxesCalls = 0;
    const client = {
      async createBox() {
        return { box: initial };
      },
      async listBoxes() {
        listBoxesCalls += 1;
        return [initial];
      },
      async startBox() {
        return {};
      },
      async stopBox() {
        return {};
      },
      async removeBox() {
        return {};
      },
      async streamEvents(options?: { signal?: AbortSignal }) {
        async function* events(): AsyncIterable<ApiStreamEvent> {
          yield {
            event: 'box.updated',
            data: { type: 'box.updated', box: updated }
          };

          await new Promise<void>((resolve) => {
            if (!options?.signal || options.signal.aborted) {
              resolve();
              return;
            }
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return events();
      },
      async streamBoxLogs() {
        return emptyLogs();
      }
    };

    const store = createDevboxStore([initial], undefined, client);
    let latest = {
      boxes: [initial],
      error: null as string | null,
      loading: false,
      openLogTabs: [] as string[],
      activeLogTab: null as string | null,
      logViewers: {} as Record<string, unknown>
    };
    const unsubscribe = store.subscribe((value) => {
      latest = value;
    });

    const disconnect = await store.connectEvents();
    await waitForCondition(() => latest.boxes.some((box) => box.id === initial.id && box.status === 'stopped'));

    expect(listBoxesCalls).toBe(1);

    disconnect();
    unsubscribe();
  });

  it('resyncs once after reconnect and does not refetch per streamed event', async () => {
    const initial = makeBox();
    const updated = makeBox({
      status: 'stopped',
      updatedAt: new Date('2026-01-01T00:00:20.000Z').toISOString()
    });

    let listBoxesCalls = 0;
    let streamCalls = 0;
    const client = {
      async createBox() {
        return { box: initial };
      },
      async listBoxes() {
        listBoxesCalls += 1;
        return [initial];
      },
      async startBox() {
        return {};
      },
      async stopBox() {
        return {};
      },
      async removeBox() {
        return {};
      },
      async streamEvents(options?: { signal?: AbortSignal }) {
        streamCalls += 1;
        if (streamCalls === 1) {
          throw new Error('simulated disconnect');
        }

        async function* events(): AsyncIterable<ApiStreamEvent> {
          yield {
            event: 'box.updated',
            data: { type: 'box.updated', box: updated }
          };

          await new Promise<void>((resolve) => {
            if (!options?.signal || options.signal.aborted) {
              resolve();
              return;
            }
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return events();
      },
      async streamBoxLogs() {
        return emptyLogs();
      }
    };

    const store = createDevboxStore([initial], undefined, client);
    let latest = {
      boxes: [initial],
      error: null as string | null,
      loading: false,
      openLogTabs: [] as string[],
      activeLogTab: null as string | null,
      logViewers: {} as Record<string, unknown>
    };
    const unsubscribe = store.subscribe((value) => {
      latest = value;
    });

    const disconnect = await store.connectEvents();
    await waitForCondition(() => latest.boxes.some((box) => box.id === initial.id && box.status === 'stopped'), 4_000);

    expect(listBoxesCalls).toBe(2);

    disconnect();
    unsubscribe();
  });

  it('removes boxes when box.removed events arrive', async () => {
    const initial = makeBox();

    const client = {
      async createBox() {
        return { box: initial };
      },
      async listBoxes() {
        return [initial];
      },
      async startBox() {
        return {};
      },
      async stopBox() {
        return {};
      },
      async removeBox() {
        return {};
      },
      async streamEvents(options?: { signal?: AbortSignal }) {
        async function* events(): AsyncIterable<ApiStreamEvent> {
          yield {
            event: 'box.removed',
            data: { type: 'box.removed', boxId: initial.id }
          };

          await new Promise<void>((resolve) => {
            if (!options?.signal || options.signal.aborted) {
              resolve();
              return;
            }
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return events();
      },
      async streamBoxLogs() {
        return emptyLogs();
      }
    };

    const store = createDevboxStore([initial], undefined, client);
    let latest = {
      boxes: [initial],
      error: null as string | null,
      loading: false,
      openLogTabs: [] as string[],
      activeLogTab: null as string | null,
      logViewers: {} as Record<string, unknown>
    };
    const unsubscribe = store.subscribe((value) => {
      latest = value;
    });

    const disconnect = await store.connectEvents();
    await waitForCondition(() => latest.boxes.length === 0);

    disconnect();
    unsubscribe();
  });

  it('closes log tabs when box.removed events arrive over SSE', async () => {
    const initial = makeBox();

    const client = {
      async createBox() {
        return { box: initial };
      },
      async listBoxes() {
        return [initial];
      },
      async startBox() {
        return {};
      },
      async stopBox() {
        return {};
      },
      async removeBox() {
        return {};
      },
      async streamEvents(options?: { signal?: AbortSignal }) {
        async function* events(): AsyncIterable<ApiStreamEvent> {
          yield {
            event: 'box.removed',
            data: { type: 'box.removed', boxId: initial.id }
          };

          await new Promise<void>((resolve) => {
            if (!options?.signal || options.signal.aborted) {
              resolve();
              return;
            }
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return events();
      },
      async streamBoxLogs() {
        async function* logs(): AsyncIterable<BoxLogsEvent> {
          yield {
            event: 'box.logs',
            data: {
              boxId: initial.id,
              stream: 'stdout',
              line: 'line-1',
              timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString()
            }
          };
        }
        return logs();
      }
    };

    const store = createDevboxStore([initial], undefined, client);
    let latest = {
      boxes: [initial],
      error: null as string | null,
      loading: false,
      openLogTabs: [] as string[],
      activeLogTab: null as string | null,
      logViewers: {} as Record<string, unknown>
    };
    const unsubscribe = store.subscribe((value) => {
      latest = value;
    });

    await store.openLogs(initial.id);
    expect(latest.openLogTabs).toEqual([initial.id]);
    expect(latest.logViewers[initial.id]).toBeTruthy();

    const disconnect = await store.connectEvents();
    await waitForCondition(() => latest.boxes.length === 0);
    await waitForCondition(() => latest.openLogTabs.length === 0);

    expect(latest.activeLogTab).toBeNull();
    expect(latest.logViewers[initial.id]).toBeUndefined();

    disconnect();
    unsubscribe();
  });

  it('marks boxes as starting when start is requested', async () => {
    const initial = makeBox({ status: 'stopped' });

    const client = {
      async createBox() {
        return { box: initial };
      },
      async listBoxes() {
        return [initial];
      },
      async startBox() {
        return {};
      },
      async stopBox() {
        return {};
      },
      async removeBox() {
        return {};
      },
      async streamEvents() {
        return emptyEvents();
      },
      async streamBoxLogs() {
        return emptyLogs();
      }
    };

    const store = createDevboxStore([initial], undefined, client);
    let latest = {
      boxes: [initial],
      error: null as string | null,
      loading: false,
      openLogTabs: [] as string[],
      activeLogTab: null as string | null,
      logViewers: {} as Record<string, unknown>
    };
    const unsubscribe = store.subscribe((value) => {
      latest = value;
    });

    await store.start(initial.id);
    expect(latest.boxes.find((box) => box.id === initial.id)?.status).toBe('starting');

    unsubscribe();
  });

  it('opens log tabs and loads snapshot logs using default tail', async () => {
    const box = makeBox();
    const streamBoxLogs = vi.fn(async (_boxId: string, options?: { follow?: boolean; tail?: number }) => {
      async function* logs(): AsyncIterable<BoxLogsEvent> {
        if (!options?.follow) {
          yield {
            event: 'box.logs',
            data: {
              boxId: box.id,
              stream: 'stdout',
              line: 'line-1',
              timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString()
            }
          };
          yield {
            event: 'box.logs',
            data: {
              boxId: box.id,
              stream: 'stderr',
              line: 'line-2',
              timestamp: new Date('2026-01-01T00:00:01.000Z').toISOString()
            }
          };
        }
      }
      return logs();
    });

    const store = createDevboxStore([box], undefined, {
      async createBox() {
        return { box };
      },
      async listBoxes() {
        return [box];
      },
      async startBox() {
        return {};
      },
      async stopBox() {
        return {};
      },
      async removeBox() {
        return {};
      },
      async streamEvents() {
        return emptyEvents();
      },
      streamBoxLogs
    });

    let latest = {
      boxes: [box],
      error: null,
      loading: false,
      openLogTabs: [] as string[],
      activeLogTab: null as string | null,
      logViewers: {} as Record<string, { lines?: unknown[] }>
    };
    const unsubscribe = store.subscribe((value) => {
      latest = value;
    });

    await store.openLogs(box.id);

    expect(latest.openLogTabs).toEqual([box.id]);
    expect(latest.activeLogTab).toBe(box.id);
    expect(latest.logViewers[box.id]?.lines).toHaveLength(2);
    expect(streamBoxLogs).toHaveBeenCalledWith(
      box.id,
      expect.objectContaining({ follow: false, tail: 200 })
    );

    unsubscribe();
  });

  it('starts follow stream and aborts when tab closes', async () => {
    const box = makeBox();
    let followAborted = false;

    const store = createDevboxStore([box], undefined, {
      async createBox() {
        return { box };
      },
      async listBoxes() {
        return [box];
      },
      async startBox() {
        return {};
      },
      async stopBox() {
        return {};
      },
      async removeBox() {
        return {};
      },
      async streamEvents() {
        return emptyEvents();
      },
      async streamBoxLogs(
        _boxId: string,
        options?: { follow?: boolean; since?: string; signal?: AbortSignal }
      ) {
        async function* logs(): AsyncIterable<BoxLogsEvent> {
          if (!options?.follow) {
            yield {
              event: 'box.logs',
              data: {
                boxId: box.id,
                stream: 'stdout',
                line: 'snapshot',
                timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString()
              }
            };
            return;
          }

          yield {
            event: 'box.logs',
            data: {
              boxId: box.id,
              stream: 'stdout',
              line: 'follow-line',
              timestamp: new Date('2026-01-01T00:00:01.000Z').toISOString()
            }
          };

          await new Promise<void>((resolve) => {
            if (!options?.signal || options.signal.aborted) {
              followAborted = true;
              resolve();
              return;
            }
            options.signal.addEventListener(
              'abort',
              () => {
                followAborted = true;
                resolve();
              },
              { once: true }
            );
          });
        }
        return logs();
      }
    });

    let latest = {
      boxes: [box],
      error: null,
      loading: false,
      openLogTabs: [] as string[],
      activeLogTab: null as string | null,
      logViewers: {} as Record<string, { lines: Array<{ line: string }>; status: string }>
    };
    const unsubscribe = store.subscribe((value) => {
      latest = value;
    });

    await store.openLogs(box.id);
    store.setLogFollow(box.id, true);

    await waitForCondition(() =>
      (latest.logViewers[box.id]?.lines ?? []).some((line) => line.line === 'follow-line')
    );

    store.closeLogs(box.id);
    await waitForCondition(() => followAborted);

    expect(latest.openLogTabs).toHaveLength(0);
    unsubscribe();
  });

  it('clears logs without stopping follow mode', async () => {
    const box = makeBox();

    const store = createDevboxStore([box], undefined, {
      async createBox() {
        return { box };
      },
      async listBoxes() {
        return [box];
      },
      async startBox() {
        return {};
      },
      async stopBox() {
        return {};
      },
      async removeBox() {
        return {};
      },
      async streamEvents() {
        return emptyEvents();
      },
      async streamBoxLogs(
        _boxId: string,
        options?: { follow?: boolean; since?: string; signal?: AbortSignal }
      ) {
        async function* logs(): AsyncIterable<BoxLogsEvent> {
          if (!options?.follow) {
            yield {
              event: 'box.logs',
              data: {
                boxId: box.id,
                stream: 'stdout',
                line: 'snapshot',
                timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString()
              }
            };
            return;
          }

          yield {
            event: 'box.logs',
            data: {
              boxId: box.id,
              stream: 'stdout',
              line: 'follow-line',
              timestamp: new Date('2026-01-01T00:00:01.000Z').toISOString()
            }
          };

          await new Promise<void>((resolve) => {
            if (!options?.signal || options.signal.aborted) {
              resolve();
              return;
            }
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }

        return logs();
      }
    });

    let latest = {
      boxes: [box],
      error: null,
      loading: false,
      openLogTabs: [] as string[],
      activeLogTab: null as string | null,
      logViewers: {} as Record<
        string,
        {
          follow: boolean;
          status: string;
          lines: Array<{ line: string }>;
        }
      >
    };
    const unsubscribe = store.subscribe((value) => {
      latest = value;
    });

    await store.openLogs(box.id);
    store.setLogFollow(box.id, true);
    await waitForCondition(
      () => latest.logViewers[box.id]?.status === 'streaming'
    );

    store.clearLogs(box.id);

    expect(latest.logViewers[box.id]?.follow).toBe(true);
    expect(latest.logViewers[box.id]?.status).toBe('streaming');
    expect(latest.logViewers[box.id]?.lines).toEqual([]);

    store.closeLogs(box.id);
    unsubscribe();
  });

  it('does not re-append replayed cursor line after follow reconnect', async () => {
    const box = makeBox();
    const firstTimestamp = '2026-01-01T00:00:01.000000000Z';
    const secondTimestamp = '2026-01-01T00:00:01.000000001Z';

    let followCalls = 0;
    const store = createDevboxStore([box], undefined, {
      async createBox() {
        return { box };
      },
      async listBoxes() {
        return [box];
      },
      async startBox() {
        return {};
      },
      async stopBox() {
        return {};
      },
      async removeBox() {
        return {};
      },
      async streamEvents() {
        return emptyEvents();
      },
      async streamBoxLogs(
        _boxId: string,
        options?: { follow?: boolean; since?: string; signal?: AbortSignal }
      ) {
        async function* logs(): AsyncIterable<BoxLogsEvent> {
          if (!options?.follow) {
            return;
          }

          followCalls += 1;
          if (followCalls === 1) {
            yield {
              event: 'box.logs',
              data: {
                boxId: box.id,
                stream: 'stdout',
                line: 'line-1',
                timestamp: firstTimestamp
              }
            };
            return;
          }

          if (options.since === firstTimestamp) {
            yield {
              event: 'box.logs',
              data: {
                boxId: box.id,
                stream: 'stdout',
                line: 'line-2',
                timestamp: secondTimestamp
              }
            };
          }

          await new Promise<void>((resolve) => {
            if (!options?.signal || options.signal.aborted) {
              resolve();
              return;
            }
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }

        return logs();
      }
    });

    let latest = {
      boxes: [box],
      error: null,
      loading: false,
      openLogTabs: [] as string[],
      activeLogTab: null as string | null,
      logViewers: {} as Record<string, { lines: Array<{ timestamp: string; line: string }> }>
    };
    const unsubscribe = store.subscribe((value) => {
      latest = value;
    });

    await store.openLogs(box.id);
    store.setLogFollow(box.id, true);
    await waitForCondition(() => (latest.logViewers[box.id]?.lines ?? []).length >= 2, 4_000);

    expect(followCalls).toBeGreaterThanOrEqual(2);
    expect(latest.logViewers[box.id]?.lines).toEqual([
      { boxId: box.id, timestamp: firstTimestamp, stream: 'stdout', line: 'line-1' },
      { boxId: box.id, timestamp: secondTimestamp, stream: 'stdout', line: 'line-2' }
    ]);

    store.closeLogs(box.id);
    unsubscribe();
  });
});
