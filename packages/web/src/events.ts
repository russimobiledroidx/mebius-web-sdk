import type { MebiusError } from "./errors.js";
import type { BroadcastStats, CaptionSegment, MebiusQuality, PlaybackStats } from "./types.js";

// NOTE: these are `type` aliases (not interfaces) so they satisfy the
// `Record<string, unknown>` constraint on TypedEmitter — TS only treats object
// type aliases (not augmentable interfaces) as having an implicit index
// signature.

/** Event payloads emitted by {@link MebiusClient}. */
export type ClientEventMap = {
  connected: void;
  disconnected: { reason?: string };
  error: MebiusError;
  /**
   * A fresh access token was fetched and is now in use. Purely informational —
   * playback and publishing continue uninterrupted; nothing needs to be done in
   * response. Useful for logging that an unattended long-running session is
   * still renewing itself.
   */
  "token-refreshed": void;
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
  /**
   * The selectable renditions changed, because the player moved to a different
   * delivery route. Fires once per accepted route, carrying the list as it now
   * stands — today always empty, since no route offers a ladder.
   */
  "qualities-changed": readonly MebiusQuality[];
};

/** Event payloads emitted by {@link MebiusCaptions}. */
export type CaptionsEventMap = {
  /** A segment became due (its `epochMs` reached the playhead). Render it. */
  segment: CaptionSegment;
  /** A previously-shown segment aged out (playhead passed its window). Clear it. */
  cleared: { segmentId: string };
  /** The SSE connection dropped. `EventSource` reconnects on its own. */
  error: void;
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

  /**
   * Emit an event to all listeners. Internal use.
   *
   * Each listener is isolated. A subscriber that throws is the subscriber's bug,
   * and letting it escape makes it ours: emits happen on the SDK's own hot paths,
   * so an exception from, say, a quality-menu handler used to unwind into the
   * route-acceptance try/catch and tear down a stream that was playing perfectly
   * — reported as a connection failure, with the real cause nowhere in sight. It
   * also let one bad listener starve every listener after it.
   *
   * Reported rather than swallowed: console is the only channel available here,
   * since raising an `error` event from inside an emit invites a loop.
   */
  protected emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as Listener<EventMap[K]>)(payload);
      } catch (cause) {
        console.error(`[mebius] listener for "${String(event)}" threw`, cause);
      }
    }
  }

  /** Remove every listener. Internal use during teardown. */
  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
