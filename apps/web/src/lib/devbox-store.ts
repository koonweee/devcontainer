import { writable } from 'svelte/store';

import {
  createApiClient,
  type ApiStreamEvent,
  type Box,
  type BoxLogsEvent
} from '@devbox/api-client';

export interface LogLine {
  timestamp: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

export type LogViewerStatus = 'idle' | 'connecting' | 'streaming' | 'error';

export interface LogViewerState {
  boxId: string;
  lines: LogLine[];
  status: LogViewerStatus;
  error: string | null;
  follow: boolean;
  tail: number;
  since?: string;
  lastActivityAt: string;
}

export interface DevboxState {
  boxes: Box[];
  error: string | null;
  loading: boolean;
  openLogTabs: string[];
  activeLogTab: string | null;
  logViewers: Record<string, LogViewerState>;
}

const SSE_RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const DEFAULT_LOG_TAIL = 200;
const PER_VIEWER_MAX_LINES = 1_000;
const GLOBAL_MAX_LINES = 6_000;

interface DevboxClient {
  createBox(input: { name: string }): Promise<{ box: Box }>;
  listBoxes(): Promise<Box[]>;
  startBox(boxId: string): Promise<unknown>;
  stopBox(boxId: string): Promise<unknown>;
  removeBox(boxId: string): Promise<unknown>;
  streamEvents(options?: { signal?: AbortSignal }): Promise<AsyncIterable<ApiStreamEvent>>;
  streamBoxLogs(
    boxId: string,
    options?: { follow?: boolean; since?: string; tail?: number; signal?: AbortSignal }
  ): Promise<AsyncIterable<BoxLogsEvent>>;
}

function upsertBox(boxes: Box[], box: Box): Box[] {
  const next = boxes.filter((item) => item.id !== box.id);
  next.push(box);
  return next.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultLogViewer(boxId: string): LogViewerState {
  return {
    boxId,
    lines: [],
    status: 'idle',
    error: null,
    follow: false,
    tail: DEFAULT_LOG_TAIL,
    lastActivityAt: nowIso()
  };
}

function trimLines(lines: LogLine[]): LogLine[] {
  if (lines.length <= PER_VIEWER_MAX_LINES) {
    return lines;
  }
  return lines.slice(lines.length - PER_VIEWER_MAX_LINES);
}

function trimGlobal(
  logViewers: Record<string, LogViewerState>,
  activeLogTab: string | null
): Record<string, LogViewerState> {
  let total = Object.values(logViewers).reduce((sum, viewer) => sum + viewer.lines.length, 0);
  if (total <= GLOBAL_MAX_LINES) {
    return logViewers;
  }

  const next = { ...logViewers };
  const entries = Object.entries(next);
  const ordered = [
    ...entries
      .filter(([boxId, viewer]) => boxId !== activeLogTab && viewer.status !== 'streaming')
      .sort((left, right) => left[1].lastActivityAt.localeCompare(right[1].lastActivityAt)),
    ...entries
      .filter(([boxId, viewer]) => boxId === activeLogTab || viewer.status === 'streaming')
      .sort((left, right) => left[1].lastActivityAt.localeCompare(right[1].lastActivityAt))
  ];

  for (const [boxId, viewer] of ordered) {
    if (total <= GLOBAL_MAX_LINES) {
      break;
    }

    const overflow = total - GLOBAL_MAX_LINES;
    if (overflow <= 0 || viewer.lines.length === 0) {
      continue;
    }

    const removeCount = Math.min(overflow, viewer.lines.length);
    next[boxId] = {
      ...viewer,
      lines: viewer.lines.slice(removeCount)
    };
    total -= removeCount;
  }

  return next;
}

function removeLogViewerState(current: DevboxState, boxId: string): DevboxState {
  if (!current.openLogTabs.includes(boxId) && !current.logViewers[boxId]) {
    return current;
  }

  const nextTabs = current.openLogTabs.filter((id) => id !== boxId);
  const nextActive =
    current.activeLogTab === boxId
      ? nextTabs.length > 0
        ? nextTabs[nextTabs.length - 1]
        : null
      : current.activeLogTab;
  const nextViewers = { ...current.logViewers };
  delete nextViewers[boxId];

  return {
    ...current,
    openLogTabs: nextTabs,
    activeLogTab: nextActive,
    logViewers: nextViewers
  };
}

function applyBoxUpdatedState(current: DevboxState, box: Box): DevboxState {
  return {
    ...current,
    boxes: upsertBox(current.boxes, box),
    error: null
  };
}

function applyBoxRemovedState(current: DevboxState, boxId: string): DevboxState {
  const next = removeLogViewerState(
    {
      ...current,
      boxes: current.boxes.filter((box) => box.id !== boxId)
    },
    boxId
  );
  return {
    ...next,
    error: null
  };
}

function applyBoxStatusState(
  current: DevboxState,
  boxId: string,
  status: Box['status']
): DevboxState {
  return {
    ...current,
    boxes: current.boxes.map((box) => (box.id === boxId ? { ...box, status } : box)),
    error: null
  };
}

async function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createDevboxStore(initialBoxes: Box[], apiBaseUrl?: string, client?: DevboxClient) {
  const initialState: DevboxState = {
    boxes: initialBoxes,
    error: null,
    loading: false,
    openLogTabs: [],
    activeLogTab: null,
    logViewers: {}
  };

  const state = writable<DevboxState>(initialState);
  let currentState = initialState;

  const setState = (next: DevboxState): void => {
    currentState = next;
    state.set(next);
  };

  const updateState = (updater: (current: DevboxState) => DevboxState): void => {
    setState(updater(currentState));
  };

  const apiClient =
    client ??
    createApiClient({
      baseUrl: apiBaseUrl ?? 'http://localhost:3000'
    });

  const logControllers = new Map<string, AbortController>();

  const stopLogStream = (boxId: string): void => {
    const active = logControllers.get(boxId);
    if (!active) {
      return;
    }
    active.abort();
    logControllers.delete(boxId);
  };

  const ensureViewer = (boxId: string): void => {
    if (currentState.logViewers[boxId]) {
      return;
    }

    updateState((current) => ({
      ...current,
      logViewers: {
        ...current.logViewers,
        [boxId]: defaultLogViewer(boxId)
      }
    }));
  };

  const touchViewer = (boxId: string): void => {
    updateState((current) => {
      const viewer = current.logViewers[boxId];
      if (!viewer) {
        return current;
      }

      return {
        ...current,
        logViewers: {
          ...current.logViewers,
          [boxId]: {
            ...viewer,
            lastActivityAt: nowIso()
          }
        }
      };
    });
  };

  const appendLogLine = (boxId: string, entry: LogLine): void => {
    updateState((current) => {
      const viewer = current.logViewers[boxId];
      if (!viewer) {
        return current;
      }

      const logViewers = {
        ...current.logViewers,
        [boxId]: {
          ...viewer,
          lines: trimLines([...viewer.lines, entry]),
          lastActivityAt: nowIso(),
          error: null
        }
      };

      return {
        ...current,
        logViewers: trimGlobal(logViewers, current.activeLogTab)
      };
    });
  };

  const setViewerState = (
    boxId: string,
    patch: Partial<Pick<LogViewerState, 'status' | 'error' | 'follow' | 'tail' | 'since' | 'lines'>>
  ): void => {
    updateState((current) => {
      const viewer = current.logViewers[boxId];
      if (!viewer) {
        return current;
      }

      const nextViewer: LogViewerState = {
        ...viewer,
        ...patch,
        lines: patch.lines !== undefined ? trimLines(patch.lines) : viewer.lines,
        lastActivityAt: nowIso()
      };

      const logViewers = {
        ...current.logViewers,
        [boxId]: nextViewer
      };

      return {
        ...current,
        logViewers: trimGlobal(logViewers, current.activeLogTab)
      };
    });
  };

  async function refresh(): Promise<void> {
    updateState((current) => ({ ...current, loading: true, error: null }));
    try {
      const boxes = await apiClient.listBoxes();
      setState({ ...currentState, boxes, error: null, loading: false });
    } catch (error) {
      updateState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to refresh boxes'
      }));
    }
  }

  async function create(name: string): Promise<void> {
    const created = await apiClient.createBox({ name });
    updateState((current) => applyBoxUpdatedState(current, created.box));
  }

  async function stop(boxId: string): Promise<void> {
    await apiClient.stopBox(boxId);
    updateState((current) => applyBoxStatusState(current, boxId, 'stopping'));
  }

  async function start(boxId: string): Promise<void> {
    await apiClient.startBox(boxId);
    updateState((current) => applyBoxStatusState(current, boxId, 'starting'));
  }

  async function remove(boxId: string): Promise<void> {
    await apiClient.removeBox(boxId);
    stopLogStream(boxId);
    updateState((current) => removeLogViewerState(applyBoxStatusState(current, boxId, 'removing'), boxId));
  }

  function applyStreamEvent(event: ApiStreamEvent): void {
    if (event.event === 'box.updated') {
      updateState((current) => applyBoxUpdatedState(current, event.data.box));
      return;
    }

    if (event.event === 'box.removed') {
      stopLogStream(event.data.boxId);
      updateState((current) => applyBoxRemovedState(current, event.data.boxId));
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

          updateState((current) => ({
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
      updateState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Event stream disconnected'
      }));
    });

    return () => {
      closed = true;
      activeStreamController?.abort();
      for (const controller of logControllers.values()) {
        controller.abort();
      }
      logControllers.clear();
    };
  }

  async function streamLogSnapshot(boxId: string): Promise<void> {
    const viewer = currentState.logViewers[boxId];
    if (!viewer) {
      return;
    }

    stopLogStream(boxId);
    const controller = new AbortController();
    logControllers.set(boxId, controller);
    setViewerState(boxId, { status: 'connecting', error: null, lines: [] });

    try {
      const stream = await apiClient.streamBoxLogs(boxId, {
        follow: false,
        since: viewer.since,
        tail: viewer.tail,
        signal: controller.signal
      });

      for await (const event of stream) {
        if (controller.signal.aborted) {
          break;
        }
        appendLogLine(boxId, event.data);
      }

      const currentViewer = currentState.logViewers[boxId];
      if (currentViewer) {
        setViewerState(boxId, {
          status: currentViewer.follow ? 'connecting' : 'idle',
          error: null
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setViewerState(boxId, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to load logs'
        });
      }
    } finally {
      if (logControllers.get(boxId) === controller) {
        logControllers.delete(boxId);
      }
    }
  }

  function startFollowLoop(boxId: string): void {
    stopLogStream(boxId);

    const controller = new AbortController();
    logControllers.set(boxId, controller);

    void (async () => {
      let reconnectAttempts = 0;

      while (!controller.signal.aborted) {
        const viewer = currentState.logViewers[boxId];
        if (!viewer || !viewer.follow) {
          break;
        }

        const latestLine = viewer.lines[viewer.lines.length - 1];
        setViewerState(boxId, { status: 'connecting', error: null });

        try {
          const stream = await apiClient.streamBoxLogs(boxId, {
            follow: true,
            since: latestLine?.timestamp ?? viewer.since,
            signal: controller.signal
          });

          setViewerState(boxId, { status: 'streaming', error: null });
          reconnectAttempts = 0;

          for await (const event of stream) {
            if (controller.signal.aborted) {
              break;
            }
            appendLogLine(boxId, event.data);
          }
        } catch (error) {
          if (controller.signal.aborted) {
            break;
          }

          setViewerState(boxId, {
            status: 'error',
            error: error instanceof Error ? error.message : 'Log stream disconnected'
          });
        }

        if (controller.signal.aborted) {
          break;
        }

        const currentViewer = currentState.logViewers[boxId];
        if (!currentViewer || !currentViewer.follow) {
          break;
        }

        const delay =
          SSE_RECONNECT_BACKOFF_MS[
            Math.min(reconnectAttempts, SSE_RECONNECT_BACKOFF_MS.length - 1)
          ];
        reconnectAttempts += 1;
        await waitWithAbort(delay, controller.signal);
      }

      if (logControllers.get(boxId) === controller) {
        logControllers.delete(boxId);
      }

      const viewer = currentState.logViewers[boxId];
      if (viewer && !viewer.follow) {
        setViewerState(boxId, { status: 'idle' });
      }
    })();
  }

  async function openLogs(
    boxId: string,
    options?: { follow?: boolean; tail?: number; since?: string }
  ): Promise<void> {
    const isNewTab = !currentState.openLogTabs.includes(boxId);
    ensureViewer(boxId);

    updateState((current) => {
      const viewer = current.logViewers[boxId] ?? defaultLogViewer(boxId);
      const nextViewer: LogViewerState = {
        ...viewer,
        follow: options?.follow ?? viewer.follow,
        tail: options?.tail ?? viewer.tail,
        since: options?.since ?? viewer.since,
        error: null,
        lastActivityAt: nowIso()
      };

      return {
        ...current,
        openLogTabs: current.openLogTabs.includes(boxId)
          ? current.openLogTabs
          : [...current.openLogTabs, boxId],
        activeLogTab: boxId,
        logViewers: {
          ...current.logViewers,
          [boxId]: nextViewer
        }
      };
    });

    if (!isNewTab) {
      return;
    }

    await streamLogSnapshot(boxId);

    const viewer = currentState.logViewers[boxId];
    if (viewer?.follow) {
      startFollowLoop(boxId);
    }
  }

  function setActiveLogTab(boxId: string): void {
    if (!currentState.openLogTabs.includes(boxId)) {
      return;
    }

    updateState((current) => ({
      ...current,
      activeLogTab: boxId
    }));
    touchViewer(boxId);
  }

  function setLogFollow(boxId: string, follow: boolean): void {
    const viewer = currentState.logViewers[boxId];
    if (!viewer) {
      return;
    }

    setViewerState(boxId, {
      follow,
      error: null,
      status: follow ? 'connecting' : 'idle'
    });

    if (follow) {
      startFollowLoop(boxId);
      return;
    }

    stopLogStream(boxId);
  }

  function clearLogs(boxId: string): void {
    setViewerState(boxId, {
      lines: [],
      status: 'idle',
      error: null
    });
  }

  function closeLogs(boxId: string): void {
    stopLogStream(boxId);
    updateState((current) => removeLogViewerState(current, boxId));
  }

  function setLogTail(boxId: string, tail: number): void {
    if (!Number.isFinite(tail) || tail < 1) {
      return;
    }

    setViewerState(boxId, {
      tail: Math.floor(tail)
    });
  }

  return {
    subscribe: state.subscribe,
    refresh,
    create,
    start,
    stop,
    remove,
    connectEvents,
    openLogs,
    closeLogs,
    setActiveLogTab,
    setLogFollow,
    clearLogs,
    setLogTail
  };
}
