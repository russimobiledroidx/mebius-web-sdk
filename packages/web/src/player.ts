import { TypedEmitter, type PlayerEventMap } from "./events.js";
import { mebiusError } from "./errors.js";
import { resolveVideoElement } from "./internal/view-target.js";
import type { SignalingClient } from "./internal/signaling.js";
import { createViewCandidates, type ViewTransport } from "./internal/transport.js";
import { QoeReporter, type TelemetryTarget } from "./internal/telemetry.js";
import { resetVideoElement } from "./internal/autoplay.js";
import { FreezeClock } from "./internal/freeze-clock.js";
import type { MebiusDelivery, MebiusQuality, PlayerOptions, ViewTarget } from "./types.js";

const STATS_INTERVAL_MS = 2000;

/**
 * How long a route gets to produce its first frame before we move to the next.
 *
 * Not arbitrary: a route can report a healthy connection and still deliver
 * nothing — a CDN edge that has no ingest yet answers 200 with an empty stream,
 * and a real-time connection reports `connected` while zero frames arrive. The
 * only trustworthy signal is the picture actually advancing, so that is what is
 * measured. 8s is long enough to survive a slow first segment on mobile data and
 * short enough that a viewer has not yet left.
 */
const FIRST_FRAME_TIMEOUT_MS = 8000;

/**
 * How long a stall is allowed to last before the route is treated as dead.
 *
 * A route that stops delivering does not announce it. flv.js reports a network
 * error as one more `waiting`, a segmented edge that restarts simply stops
 * answering,
 * and the element sits on its last decoded frame — which is what a viewer calls
 * a black screen. Nothing downstream can tell that apart from a slow segment, so
 * the only usable signal is how long the picture has not moved.
 *
 * 10s is deliberately longer than the 8s first-frame budget: a route that is
 * merely slow deserves to finish, and reopening a healthy stream costs the
 * viewer a rebuffer.
 */
const STALL_RECOVERY_MS = 10_000;

/**
 * How many times a lost route is reopened before the session is declared over.
 *
 * The SDK cannot tell "the broadcast ended" from "the edge dropped us": both
 * look like a route that stopped producing frames. So it assumes the recoverable
 * case, which is the common one on a long broadcast, and spends a bounded amount
 * of time proving itself wrong. Five attempts with the backoff below is about
 * half a minute of waiting plus one route walk per attempt — long enough to ride
 * out an edge restart or a publisher reconnect, short enough that a viewer
 * watching a stream that really ended is not left staring at a spinner.
 */
const MAX_RECOVERY_ATTEMPTS = 5;

/** First delay before reopening; doubles per attempt up to RECOVERY_MAX_MS. */
const RECOVERY_BASE_MS = 1000;

/**
 * Ceiling on the reopen delay. Bounded because every viewer of one broadcast
 * fails at the same instant — an edge restart is not an individual event — and
 * an unbounded retry storm from a full room is how a recovery mechanism becomes
 * the outage.
 */
const RECOVERY_MAX_MS = 30_000;

/**
 * Which player currently drives a given element.
 *
 * A second player on the same element is an ordinary thing for an app to do —
 * a "play" button pressed twice, a component remounting — and it used to
 * orphan the first one. The new player resets the element, which detaches the
 * old MediaSource and removes its SourceBuffers, but the old player is still
 * running: its buffered-media library keeps polling buffers that no longer
 * belong to anything and floods the console with
 *
 *   InvalidStateError: Failed to read the 'buffered' property from
 *   'SourceBuffer': This SourceBuffer has been removed from the parent media
 *   source.
 *
 * The element can only have one owner, so taking ownership retires the
 * previous one. WeakMap because an element that goes out of scope must not be
 * kept alive by this bookkeeping.
 */
const ELEMENT_OWNER = new WeakMap<HTMLVideoElement, MebiusPlayer>();

/**
 * Plays a Mebius stream into a `<video>` element.
 *
 * Create one with {@link MebiusClient.createPlayer}, optionally choosing a
 * playback {@link PlaybackMode | mode}; Mebius selects the delivery route, and
 * moves to the next one by itself if the current one stops producing frames.
 */
export class MebiusPlayer extends TypedEmitter<PlayerEventMap> {
  private readonly candidates: ViewTransport[];
  private transport: ViewTransport | null = null;
  private video: HTMLVideoElement | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private playing = false;
  private reporter: QoeReporter | null = null;
  /** True between a `buffering` event and the element actually resuming. */
  private stalled = false;
  /** Measures how long playback was actually frozen; see FreezeClock. */
  private readonly freeze = new FreezeClock();
  /** Cancels element listeners bound for the lifetime of one play(). */
  private elementListeners: AbortController | null = null;
  /** Renditions the active route actually offers. See {@link qualities}. */
  private renditions: readonly MebiusQuality[] = Object.freeze([]);
  /** The stream being played, so a lost route can be reopened without the caller. */
  private streamId: string | null = null;
  /** True while reopening a lost route; keeps recovery and play() off each other. */
  private recovering = false;
  /** Consecutive reopen attempts without playback in between. Reset on `playing`. */
  private recoveryAttempts = 0;
  /** Counts down a stall towards recovery; cancelled the moment the picture moves. */
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped by stop(). A recovery loop that started before the caller stopped us
   * must not reopen a route into an element the app has moved on from, and it
   * can be several seconds inside a backoff when that happens.
   */
  private session = 0;

  /** @internal */
  constructor(
    signaling: SignalingClient,
    options: PlayerOptions = {},
    deliveries: readonly MebiusDelivery[] = [],
    private readonly telemetry: TelemetryTarget | null = null,
    private readonly userId?: string,
  ) {
    super();
    this.candidates = createViewCandidates(
      options.mode ?? "auto",
      signaling,
      deliveries,
      options.targetLatencyMs,
    );
  }

  /** Start playing `streamId` into the given video element or selector. */
  async play(streamId: string, viewTarget: ViewTarget): Promise<void> {
    // `recovering` counts as playing for this guard: recovery sets `playing`
    // false while it reopens, and without this an app that calls play() on its
    // own `buffering` handler would open a second route into the same element
    // and race the one already coming back.
    if (this.playing || this.recovering) return;
    const video = resolveVideoElement(viewTarget);
    // One element, one player. Whatever was driving it is finished, and stopping
    // it here is what keeps a second play() from leaving a live transport
    // attached to a MediaSource this one is about to replace.
    const previous = ELEMENT_OWNER.get(video);
    if (previous && previous !== this) await previous.stop();
    ELEMENT_OWNER.set(video, this);
    this.video = video;

    // `buffering` had no counterpart: an app that showed a spinner on it had
    // nothing to hide the spinner on, so a single mid-stream stall left the UI
    // reading "buffering" over perfectly smooth video for the rest of the
    // session. The element knows when it resumed; re-emitting `playing` there
    // gives every consumer the other half of the pair without inventing an
    // event they would have to know to handle.
    this.elementListeners = new AbortController();
    video.addEventListener(
      "playing",
      () => {
        // The picture moved, so whatever stall was counting down towards a
        // reopen is over, and the route has proven itself again: the recovery
        // budget resets here rather than on route acceptance, because accepting
        // a route only means it opened, not that it is delivering.
        this.clearStallTimer();
        this.recoveryAttempts = 0;
        if (!this.stalled || !this.playing) return;
        this.stalled = false;
        this.freeze.endStall();
        this.emit("playing", { streamId });
      },
      { signal: this.elementListeners.signal },
    );

    this.streamId = streamId;
    const failure = await this.openRoute(streamId, video);
    if (failure === null) return;

    // Release the element before giving up. Holding ownership of an element we
    // are not playing into would make the next player await a stop() on this
    // dead one, and would keep this player object alive through the map for as
    // long as the element exists.
    this.elementListeners?.abort();
    this.elementListeners = null;
    if (ELEMENT_OWNER.get(video) === this) ELEMENT_OWNER.delete(video);
    this.video = null;
    throw failure;
  }

  /**
   * Try every candidate route in order and keep the first one that delivers.
   *
   * Separated from play() because it runs twice for two different reasons: once
   * to start, and again whenever a route that WAS delivering stops (see
   * {@link recover}). Reopening has to walk the same list in the same order —
   * the route that died is often not the best one still standing — and the only
   * difference is that the second caller does not own the element setup.
   *
   * Returns `null` when a route was accepted, or the error to report when none
   * of them produced a picture.
   */
  private async openRoute(streamId: string, video: HTMLVideoElement): Promise<unknown | null> {
    // Measured across route attempts, not from the accepted route: a viewer who
    // waited through a dead edge waited, and reporting only the winning route's
    // time would hide exactly the delay worth knowing about.
    const startedAtMs = Date.now();
    let lastError: unknown = null;
    for (const candidate of this.candidates) {
      try {
        // Hand every route a clean element. Routes attach differently — a
        // MediaStream via srcObject, a playlist via src, MSE via attachMedia —
        // and while srcObject is set the element ignores src entirely. Without
        // this, one failed real-time attempt kept every later route black while
        // its own logs looked healthy.
        resetVideoElement(video);
        this.attach(candidate);
        await candidate.start(streamId, video);
        // start() resolving only means the route was opened, not that it is
        // delivering. Confirm with the picture itself before accepting it.
        if (await hasFirstFrame(video)) {
          this.transport = candidate;
          this.playing = true;
          // Routes may differ in what they can offer, so the list is published per
          // accepted route rather than once per player.
          this.publishQualities();
          if (this.telemetry) {
            this.reporter = new QoeReporter(
              this.telemetry,
              "play",
              streamId,
              this.userId,
              candidate.kind,
            );
            this.reporter.start();
            // One sample at join time carries the join delay. Viewer minutes are
            // derived from the span between a session's first and last sample, so
            // a viewer who leaves before the first stats tick still counts.
            this.reporter.add({ ts: Math.floor(Date.now() / 1000), firstFrameMs: Date.now() - startedAtMs });
          }
          this.startStats();
          // Proven delivering — hasFirstFrame only resolves once the picture
          // moved — so the budget starts over here as well as on the element's
          // own `playing`. The budget is for CONSECUTIVE failures, and relying
          // on a DOM event alone would let a long broadcast that loses its route
          // once an hour run out of attempts by the afternoon.
          this.recoveryAttempts = 0;
          this.emit("playing", { streamId });
          return null;
        }
        lastError = mebiusError("CONNECTION_FAILED", "A Mebius route delivered no video.");
      } catch (cause) {
        lastError = cause;
      }
      // Tear the dead route down before opening the next one: leaving it attached
      // keeps a peer connection or a media source bound to the same element, and
      // the next route then renders into a element that is not free.
      await candidate.stop().catch(() => undefined);
    }
    return lastError ?? mebiusError("CONNECTION_FAILED", "No Mebius route could play this stream.");
  }

  /** Stop playback and detach from the video element. */
  async stop(): Promise<void> {
    // Retires a recovery that may be sitting in a backoff right now; it checks
    // this on the way out of every await.
    this.session += 1;
    this.recoveryAttempts = 0;
    this.clearStallTimer();
    this.elementListeners?.abort();
    this.elementListeners = null;
    if (this.video && ELEMENT_OWNER.get(this.video) === this) {
      ELEMENT_OWNER.delete(this.video);
    }
    this.stalled = false;
    this.freeze.reset();
    this.stopStats();
    await this.reporter?.stop();
    this.reporter = null;
    await this.transport?.stop();
    this.transport = null;
    this.video = null;
    this.playing = false;
  }

  /**
   * Set output volume in the range 0..1.
   *
   * Any volume above zero also unmutes. Playback often starts muted — the
   * element may carry `muted` in the app's own markup, and the SDK itself mutes
   * and retries when the browser refuses to autoplay with sound — and
   * `video.volume` has no audible effect while `muted` is set. Setting volume
   * without clearing it meant an app whose only audio control was a slider
   * could never produce sound: the value moved, the stream stayed silent, and
   * nothing reported a problem.
   *
   * Volume 0 mutes rather than merely turning the level down, so a UI that
   * drags to zero also survives a later unmute at the element level.
   */
  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    if (!this.video) return;
    this.video.volume = v;
    this.video.muted = v === 0;
  }

  /**
   * Renditions this stream can actually be switched between.
   *
   * Empty means there is exactly one rendition — or a route with no such concept —
   * and a UI should HIDE its quality menu rather than offer a choice that does not
   * exist. That is the whole reason this exists: a player built against a
   * rendition ladder has a menu, and without a programmatic answer the only
   * options were to show a fake one or to delete the feature on a hunch.
   *
   * It is empty for every Mebius stream today: the engine publishes one rendition
   * and does no ladder transcoding. The field is here so a client can be written
   * once, against the honest answer, and keep working unchanged if that ever
   * changes.
   *
   * The list is per ROUTE, so it is re-read on failover and announced with
   * `qualities-changed`.
   */
  get qualities(): readonly MebiusQuality[] {
    return this.renditions;
  }

  /**
   * Choose a rendition, or `"auto"` to let Mebius decide (the default).
   *
   * Rejects an id that is not in {@link qualities} instead of silently doing
   * nothing — a UI that asks for a rendition and gets no error would otherwise
   * show the wrong state forever. Rejecting does not touch playback: the stream
   * keeps running on whatever it is running on.
   */
  async setQuality(id: "auto" | string): Promise<void> {
    if (id !== "auto" && !this.renditions.some((q) => q.id === id)) {
      throw mebiusError(
        "UNKNOWN",
        `Unknown quality "${id}". Pass "auto", or an id from player.qualities.`,
      );
    }
    // With one rendition there is nothing to switch to, so an accepted call is a
    // no-op. No state is kept for it: an unread "selected id" would be a second
    // source of truth to keep in step with the route, for no reader.
  }

  /**
   * Wall-clock time (Unix ms) currently on screen, or `null` when the active
   * route cannot produce one. A real-time route carries no wall clock at all,
   * and a segmented route has none until its first timestamped segment arrives
   * (see {@link ViewTransport}).
   *
   * This is what {@link MebiusClient.createCaptions} compares against a
   * segment's `epochMs` to know when it is due. Delegating to the transport
   * rather than reading the element directly is what keeps this correct across
   * a route failover: the player may change route mid-session, and the clock
   * source has to follow.
   */
  currentEpochMs(): number | null {
    return this.transport?.playheadEpochMs?.() ?? null;
  }

  /**
   * Re-read the renditions for the route now serving and tell listeners.
   *
   * Emitted unconditionally on route acceptance, not only when the list differs:
   * "the route changed, here is what it offers" is the fact a client acts on, and
   * suppressing an identical list would make the event fire or not depending on
   * which route happened to win.
   */
  private publishQualities(): void {
    // No Mebius route exposes a ladder — the engine publishes a single rendition
    // (`hlsVariant: lowLatency`, no ABR). Empty is the truthful answer, and this is
    // the one place that has to change if that stops being true.
    this.renditions = Object.freeze([]);
    this.emit("qualities-changed", this.renditions);
  }

  private attach(transport: ViewTransport): void {
    transport.onEnded(() => {
      // Only the route currently serving may end playback. A route we already
      // abandoned firing late must not close a stream that is playing fine.
      if (this.transport !== transport) return;
      // Not necessarily the end of the broadcast. A segmented route reports the
      // end of what IT can serve — the publisher reconnected, the edge recycled
      // the session, the playlist went away for a moment — and on a broadcast
      // that runs for days that happens long before the host stops. So this is
      // treated as a lost route and proven to be an ending, rather than assumed
      // to be one; `ended` is emitted from recover() once reopening has failed.
      void this.recover();
    });
    transport.onBuffering(() => {
      if (this.transport !== transport) return;
      // Re-entering `buffering` while already stalled must not restart the
      // clock: flv.js fires `waiting` repeatedly through one long stall, and
      // resetting the start each time would report a fraction of the freeze.
      this.freeze.beginStall();
      this.stalled = true;
      // A stall that never ends is the black screen this whole mechanism exists
      // for, and it arrives as a `waiting` that is simply never followed by a
      // `playing`. Arm the countdown on the first one and let the element cancel
      // it; re-arming on every repeat would push the deadline out forever,
      // because flv.js keeps firing them while the picture stays frozen.
      if (!this.stallTimer) {
        this.stallTimer = setTimeout(() => {
          this.stallTimer = null;
          void this.recover();
        }, STALL_RECOVERY_MS);
      }
      this.emit("buffering", undefined);
    });
  }

  /**
   * Releases whatever route is attached, without touching the element or the
   * session. A method rather than four inline lines because recovery needs it in
   * two places, and one of them runs after the other has already nulled the
   * fields — which TypeScript reads as "these can only be null now".
   */
  private async releaseRoute(): Promise<void> {
    this.stopStats();
    await this.reporter?.stop();
    this.reporter = null;
    await this.transport?.stop().catch(() => undefined);
    this.transport = null;
    this.playing = false;
  }

  private clearStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  /**
   * Reopen the stream after the serving route stopped delivering.
   *
   * This is the difference between a broadcast a viewer can leave running and
   * one that has to be reloaded by hand. Route selection used to happen exactly
   * once, at play(): the first route that produced a frame was kept for the rest
   * of the session, and if it later died — a CDN edge restarting, a publisher
   * reconnecting, a laptop's network dropping for a second — the element simply
   * held its last decoded frame. The SDK reported `buffering` and then nothing
   * at all. On a 90-minute match that was rare enough to look like bad luck; on
   * a channel that runs for a day it is a certainty, and the viewer's word for
   * it is "black screen".
   *
   * The reopen walks the full candidate list again rather than retrying the dead
   * route, because the common causes take out one route and not the others.
   *
   * The token needs no special handling: {@link MebiusClient} renews it on its
   * own schedule whether or not anything is playing, and every transport stamps
   * the CURRENT token when it builds its URL — so a route reopened after an hour
   * of stalling gets today's credential, not the one it first connected with.
   */
  private async recover(): Promise<void> {
    if (this.recovering) return;
    const video = this.video;
    const streamId = this.streamId;
    if (!video || !streamId) return;

    this.recovering = true;
    const session = this.session;
    this.clearStallTimer();
    // Tell the UI before the first backoff, not after it. In the `ended` case
    // nothing has reported a stall yet, and a spinner that appears a second
    // later still beats a frozen frame with no explanation.
    if (!this.stalled) {
      this.freeze.beginStall();
      this.stalled = true;
      this.emit("buffering", undefined);
    }

    try {
      while (this.session === session && this.recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
        const wait = Math.min(RECOVERY_BASE_MS * 2 ** this.recoveryAttempts, RECOVERY_MAX_MS);
        this.recoveryAttempts += 1;
        await new Promise((r) => setTimeout(r, wait));
        // stop() can land anywhere inside that wait, and reopening a route into
        // an element the app has already moved on from is worse than not
        // recovering at all.
        if (this.session !== session) return;

        await this.releaseRoute();

        const failure = await this.openRoute(streamId, video);
        if (this.session !== session) {
          // stop() landed while the route was opening. openRoute may have just
          // accepted one — transport attached, stats running, telemetry
          // reporting — and stop() cannot have torn that down, because it ran
          // when there was nothing yet to tear down. Leaving now would keep a
          // stopped player playing.
          await this.releaseRoute();
          return;
        }
        if (failure === null) return;
      }
      if (this.session !== session) return;

      // Every route refused for the whole budget. Either the broadcast really is
      // over or the viewer's own connection is gone; both are the end of this
      // session as far as anything downstream is concerned.
      this.playing = false;
      this.stopStats();
      void this.reporter?.stop();
      this.reporter = null;
      // Closes the session to further recovery. Without it a late callback from
      // the last dead route re-enters here with the budget already spent and
      // emits a second `ended` — and an app that tears itself down on `ended`
      // gets to do it twice.
      this.streamId = null;
      this.emit("ended", undefined);
    } finally {
      this.recovering = false;
    }
  }

  private startStats(): void {
    this.statsTimer = setInterval(async () => {
      const stats = await this.transport?.getStats();
      // Freeze time is reported even when the transport has no stats to give:
      // a route too stalled to produce statistics is precisely the one whose
      // freezes matter most.
      const elementFreezeMs = this.freeze.take();
      if (!stats) {
        if (elementFreezeMs > 0) {
          this.reporter?.add({ ts: Math.floor(Date.now() / 1000), freezeMs: elementFreezeMs });
        }
        return;
      }
      this.emit("stats", stats);
      // Two sources, added rather than chosen between, because they see
      // different things and never the same one twice. The element reports the
      // stalls it raises events for; a real-time route raises none — it can sit
      // frozen for seconds while the connection reports perfect health — so it
      // measures its own and reports it here. Whichever route is serving, one of
      // the two is zero.
      this.reporter?.add({
        ts: Math.floor(Date.now() / 1000),
        bitrateKbps: stats.bitrateKbps,
        fps: stats.framesPerSecond,
        rttMs: stats.rttMs,
        packetLossPct: stats.packetLossPct,
        freezeMs: elementFreezeMs + (stats.freezeMs ?? 0),
      });
    }, STATS_INTERVAL_MS);
  }

  private stopStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }
}

/**
 * Resolves true once the element is actually rendering, false on timeout.
 *
 * `timeupdate` is the signal rather than `readyState` because readiness only
 * says data arrived; a live stream that stalls right after its first buffer can
 * report ready forever without the picture moving.
 */
function hasFirstFrame(video: HTMLVideoElement): Promise<boolean> {
  if (video.currentTime > 0 && !video.paused) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      video.removeEventListener("timeupdate", onTime);
      resolve(ok);
    };
    const onTime = () => {
      if (video.currentTime > 0) done(true);
    };
    const timer = setTimeout(() => done(false), FIRST_FRAME_TIMEOUT_MS);
    video.addEventListener("timeupdate", onTime);
  });
}
