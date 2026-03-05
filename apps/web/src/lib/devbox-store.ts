import { writable } from 'svelte/store';

import { createApiClient, type Box } from '@devbox/api-client';

export interface DevboxState {
  boxes: Box[];
  error: string | null;
  loading: boolean;
}

export function createDevboxStore(initialBoxes: Box[], apiBaseUrl?: string) {
  const state = writable<DevboxState>({
    boxes: initialBoxes,
    error: null,
    loading: false
  });

  const client = createApiClient({
    baseUrl: apiBaseUrl ?? 'http://localhost:3000'
  });

  async function refresh(): Promise<void> {
    state.update((current) => ({ ...current, loading: true, error: null }));
    try {
      const boxes = await client.listBoxes();
      state.set({ boxes, error: null, loading: false });
    } catch (error) {
      state.update((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to refresh boxes'
      }));
    }
  }

  async function create(name: string): Promise<void> {
    await client.createBox({ name });
    await refresh();
  }

  async function stop(boxId: string): Promise<void> {
    await client.stopBox(boxId);
    await refresh();
  }

  async function remove(boxId: string): Promise<void> {
    await client.removeBox(boxId);
    await refresh();
  }

  async function connectEvents(): Promise<() => void> {
    let closed = false;

    (async () => {
      const events = await client.streamEvents();
      for await (const event of events) {
        if (closed) {
          break;
        }
        if (event.event === 'job.updated' || event.event === 'box.updated') {
          await refresh();
        }
      }
    })().catch((error) => {
      state.update((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Event stream disconnected'
      }));
    });

    return () => {
      closed = true;
    };
  }

  return {
    subscribe: state.subscribe,
    refresh,
    create,
    stop,
    remove,
    connectEvents
  };
}
