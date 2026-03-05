import { EventEmitter } from 'node:events';

import type { OrchestratorEventMap } from './types.js';

type EventType = keyof OrchestratorEventMap;
type EventPayload<T extends EventType> = OrchestratorEventMap[T];

type Listener = (event: OrchestratorEventMap[EventType]) => void;

/** Broadcasts box and job lifecycle events to API subscribers. */
export class OrchestratorEvents {
  private readonly emitter = new EventEmitter();

  emit<T extends EventType>(type: T, payload: EventPayload<T>): void {
    this.emitter.emit('event', payload);
    this.emitter.emit(type, payload);
  }

  subscribe(listener: Listener): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }
}
