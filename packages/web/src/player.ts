import { TypedEmitter, type PlayerEventMap } from "./events.js";
import { mebiusError } from "./errors.js";
import { resolveVideoElement } from "./internal/view-target.js";
import type { SignalingClient } from "./internal/signaling.js";
import { createViewCandidates, type ViewTransport } from "./internal/transport.js";
import { QoeReporter, type TelemetryTarget } from "./internal/telemetry.js";
import { resetVideoElement } from "./internal/autoplay.js";
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
    this.video = video;

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
            this.reporter = new QoeReporter(this.telemetry, "play", streamId, this.userId);
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

    this.video = null;
    throw lastError ?? mebiusError("CONNECTION_FAILED", "No Mebius route could play this stream.");
  }

  /** Stop playback and detach from the video element. */
  async stop(): Promise<void> {
    this.stopStats();
    await this.reporter?.stop();
    this.reporter = null;
    await this.transport?.stop();
    this.transport = null;
    this.video = null;
    this.playing = false;
  }

  /** Set output volume in the range 0..1. */
  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    if (this.video) this.video.volume = v;
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
      this.emit("buffering", undefined);
    });
  }

  private startStats(): void {
    this.statsTimer = setInterval(async () => {
      const stats = await this.transport?.getStats();
      if (!stats) return;
      this.emit("stats", stats);
      this.reporter?.add({
        ts: Math.floor(Date.now() / 1000),
        bitrateKbps: stats.bitrateKbps,
        fps: stats.framesPerSecond,
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
