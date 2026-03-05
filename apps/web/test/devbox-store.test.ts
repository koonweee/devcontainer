import { describe, expect, it } from 'vitest';
import type { ApiStreamEvent, Box } from '@devbox/api-client';

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

async function waitForCondition(
  check: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
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
      }
    };

    const store = createDevboxStore([initial], undefined, client);
    let latest = { boxes: [initial], error: null as string | null, loading: false };
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
      }
    };

    const store = createDevboxStore([initial], undefined, client);
    let latest = { boxes: [initial], error: null as string | null, loading: false };
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
      }
    };

    const store = createDevboxStore([initial], undefined, client);
    let latest = { boxes: [initial], error: null as string | null, loading: false };
    const unsubscribe = store.subscribe((value) => {
      latest = value;
    });

    const disconnect = await store.connectEvents();
    await waitForCondition(() => latest.boxes.length === 0);

    disconnect();
    unsubscribe();
  });
});
