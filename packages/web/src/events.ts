import type { MebiusError } from "./errors.js";
import type { BroadcastStats, PlaybackStats } from "./types.js";

// NOTE: these are `type` aliases (not interfaces) so they satisfy the
// `Record<string, unknown>` constraint on TypedEmitter — TS only treats object
// type aliases (not augmentable interfaces) as having an implicit index
// signature.

/** Event payloads emitted by {@link MebiusClient}. */
export type ClientEventMap = {
  connected: void;
  disconnected: { reason?: string };
  error: MebiusError;
};

/** Event payloads emitted by a broadcaster. */
export type BroadcasterEventMap = {
  started: { streamId: string };
  stopped: void;
  stats: BroadcastStats;
};

/** Event payloads emitted by a player. */
export type PlayerEventMap = {
  playing: { streamId: string };
  buffering: void;
  ended: void;
  stats: PlaybackStats;
};

type Listener<T> = (payload: T) => void;

/**
 * A tiny strongly-typed event emitter. `EventMap` maps each event name to its
 * payload type, so `on("started", cb)` infers `cb`'s argument automatically.
 */
export class TypedEmitter<EventMap extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof EventMap, Set<Listener<unknown>>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof EventMap>(event: K, cb: Listener<EventMap[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as Listener<unknown>);
    return () => this.off(event, cb);
  }

  /** Unsubscribe a previously-registered listener. */
  off<K extends keyof EventMap>(event: K, cb: Listener<EventMap[K]>): void {
    this.listeners.get(event)?.delete(cb as Listener<unknown>);
  }

  /** Emit an event to all listeners. Internal use. */
  protected emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) (cb as Listener<EventMap[K]>)(payload);
  }

  /** Remove every listener. Internal use during teardown. */
  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
