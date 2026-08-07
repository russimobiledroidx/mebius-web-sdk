import { TypedEmitter, type PlayerEventMap } from "./events.js";
import { mebiusError } from "./errors.js";
import { resolveVideoElement } from "./internal/view-target.js";
import type { SignalingClient } from "./internal/signaling.js";
import { createViewCandidates, type ViewTransport } from "./internal/transport.js";
import { QoeReporter, type TelemetryTarget } from "./internal/telemetry.js";
import { resetVideoElement } from "./internal/autoplay.js";
import { FreezeClock } from "./internal/freeze-clock.js";
import type { MebiusDelivery, PlayerOptions, ViewTarget } from "./types.js";

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

  /** @internal */
  constructor(
    signaling: SignalingClient,
    options: PlayerOptions = {},
    deliveries: readonly MebiusDelivery[] = [],
    private readonly telemetry: TelemetryTarget | null = null,
    private readonly userId?: string,
  ) {
    super();
    this.candidates = createViewCandidates(options.mode ?? "auto", signaling, deliveries);
  }

  /** Start playing `streamId` into the given video element or selector. */
  async play(streamId: string, viewTarget: ViewTarget): Promise<void> {
    if (this.playing) return;
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
        if (!this.stalled || !this.playing) return;
        this.stalled = false;
        this.freeze.endStall();
        this.emit("playing", { streamId });
      },
      { signal: this.elementListeners.signal },
    );

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
          this.emit("playing", { streamId });
          return;
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

    // Release the element before giving up. Holding ownership of an element we
    // are not playing into would make the next player await a stop() on this
    // dead one, and would keep this player object alive through the map for as
    // long as the element exists.
    this.elementListeners?.abort();
    this.elementListeners = null;
    if (ELEMENT_OWNER.get(video) === this) ELEMENT_OWNER.delete(video);
    this.video = null;
    throw lastError ?? mebiusError("CONNECTION_FAILED", "No Mebius route could play this stream.");
  }

  /** Stop playback and detach from the video element. */
  async stop(): Promise<void> {
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

  private attach(transport: ViewTransport): void {
    transport.onEnded(() => {
      // Only the route currently serving may end playback. A route we already
      // abandoned firing late must not close a stream that is playing fine.
      if (this.transport !== transport) return;
      this.playing = false;
      this.stopStats();
      // A stream ending is a session ending: flush now or the watch time since the
      // last batch is never counted.
      void this.reporter?.stop();
      this.reporter = null;
      this.emit("ended", undefined);
    });
    transport.onBuffering(() => {
      if (this.transport !== transport) return;
      // Re-entering `buffering` while already stalled must not restart the
      // clock: flv.js fires `waiting` repeatedly through one long stall, and
      // resetting the start each time would report a fraction of the freeze.
      this.freeze.beginStall();
      this.stalled = true;
      this.emit("buffering", undefined);
    });
  }

  private startStats(): void {
    this.statsTimer = setInterval(async () => {
      const stats = await this.transport?.getStats();
      // Freeze time is reported even when the transport has no stats to give:
      // a route too stalled to produce statistics is precisely the one whose
      // freezes matter most.
      const freezeMs = this.freeze.take();
      if (!stats) {
        if (freezeMs > 0) this.reporter?.add({ ts: Math.floor(Date.now() / 1000), freezeMs });
        return;
      }
      this.emit("stats", stats);
      this.reporter?.add({
        ts: Math.floor(Date.now() / 1000),
        bitrateKbps: stats.bitrateKbps,
        fps: stats.framesPerSecond,
        freezeMs,
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
