import { writable } from 'svelte/store';

import {
  createApiClient,
  type ApiStreamEvent,
  type Box
} from '@devbox/api-client';

export interface DevboxState {
  boxes: Box[];
  error: string | null;
  loading: boolean;
}

const SSE_RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;

interface DevboxClient {
  createBox(input: { name: string }): Promise<{ box: Box }>;
  listBoxes(): Promise<Box[]>;
  stopBox(boxId: string): Promise<unknown>;
  removeBox(boxId: string): Promise<unknown>;
  streamEvents(options?: { signal?: AbortSignal }): Promise<AsyncIterable<ApiStreamEvent>>;
}

function upsertBox(boxes: Box[], box: Box): Box[] {
  const next = boxes.filter((item) => item.id !== box.id);
  next.push(box);
  return next.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function createDevboxStore(initialBoxes: Box[], apiBaseUrl?: string, client?: DevboxClient) {
  const state = writable<DevboxState>({
    boxes: initialBoxes,
    error: null,
    loading: false
  });

  const apiClient =
    client ??
    createApiClient({
      baseUrl: apiBaseUrl ?? 'http://localhost:3000'
    });

  async function refresh(): Promise<void> {
    state.update((current) => ({ ...current, loading: true, error: null }));
    try {
      const boxes = await apiClient.listBoxes();
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
    const created = await apiClient.createBox({ name });
    state.update((current) => ({
      ...current,
      boxes: upsertBox(current.boxes, created.box),
      error: null
    }));
  }

  async function stop(boxId: string): Promise<void> {
    await apiClient.stopBox(boxId);
    state.update((current) => ({
      ...current,
      boxes: current.boxes.map((box) => (box.id === boxId ? { ...box, status: 'stopping' } : box)),
      error: null
    }));
  }

  async function remove(boxId: string): Promise<void> {
    await apiClient.removeBox(boxId);
    state.update((current) => ({
      ...current,
      boxes: current.boxes.map((box) => (box.id === boxId ? { ...box, status: 'removing' } : box)),
      error: null
    }));
  }

  function applyStreamEvent(event: ApiStreamEvent): void {
    if (event.event === 'box.updated') {
      state.update((current) => ({
        ...current,
        boxes: upsertBox(current.boxes, event.data.box),
        error: null
      }));
      return;
    }

    if (event.event === 'box.removed') {
      state.update((current) => ({
        ...current,
        boxes: current.boxes.filter((box) => box.id !== event.data.boxId),
        error: null
      }));
    }
  }

  async function connectEvents(): Promise<() => void> {
    let closed = false;
    let activeStreamController: AbortController | null = null;

    (async () => {
      let reconnectAttempts = 0;
      let needsResync = true;

      while (!closed) {
        if (needsResync) {
          await refresh();
          needsResync = false;
        }

        const streamController = new AbortController();
        activeStreamController = streamController;

        try {
          const events = await apiClient.streamEvents({
            signal: streamController.signal
          });
          reconnectAttempts = 0;

          for await (const event of events) {
            if (closed) {
              break;
            }
            applyStreamEvent(event);
          }

          needsResync = true;
        } catch (error) {
          if (closed) {
            break;
          }

          state.update((current) => ({
            ...current,
            error: error instanceof Error ? error.message : 'Event stream disconnected'
          }));
          needsResync = true;
        } finally {
          if (activeStreamController === streamController) {
            activeStreamController = null;
          }
          streamController.abort();
        }

        if (closed) {
          break;
        }

        const delay =
          SSE_RECONNECT_BACKOFF_MS[
            Math.min(reconnectAttempts, SSE_RECONNECT_BACKOFF_MS.length - 1)
          ];
        reconnectAttempts += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })().catch((error) => {
      state.update((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Event stream disconnected'
      }));
    });

    return () => {
      closed = true;
      activeStreamController?.abort();
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
