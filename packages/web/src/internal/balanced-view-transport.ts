/**
 * INTERNAL — balanced view transport (HTTP-FLV via flv.js).
 *
 * For typical one-to-many web viewers Mebius pulls an HTTP-FLV stream and feeds
 * it through flv.js (Media Source Extensions). Latency is ~1-3s — lower than
 * HLS, higher than the WebRTC pull — and it scales over a CDN edge.
 *
 * History worth keeping: 0.2.0 deleted this file on the reading that the mode
 * was "unserved", because the gateway had no route for it. The route simply had
 * not been built yet — production web playback has always been HTTP-FLV. The
 * gateway now serves it, so this comes back, with one change: the URL is no
 * longer derived from a hardcoded path. It comes from the gateway's own
 * delivery list, so the gateway can move or re-point that path without an SDK
 * release.
 *
 * Browser-only: flv.js needs MSE, which iOS Safari lacks — createViewCandidates
 * is what keeps this off platforms that cannot play it. flv.js is a BUNDLED
 * dependency, never a peer dependency: an integrator must never have to type a
 * transport library's name to make Mebius work.
 *
 * Hidden from the public API; the public surface speaks only of the
 * `"balanced"` playback mode.
 */
import type { PlaybackStats } from "../types.js";
import { mebiusError } from "../errors.js";
import type { SignalingClient } from "./signaling.js";
import type { ViewTransport } from "./transport.js";
import { playWithAutoplayFallback } from "./autoplay.js";

type FlvModule = typeof import("flv.js");
type FlvPlayer = ReturnType<FlvModule["default"]["createPlayer"]>;

/**
 * flv.js tuned for live rather than for its VOD defaults.
 *
 * The defaults cost us both things this route exists to provide:
 *   - `enableStashBuffer: true` with a 384KB initial stash holds bytes in the IO
 *     layer before any of them reach MSE. At a webcam's ~400kbps that is ~8s of
 *     nothing on screen — past the player's first-frame watchdog, so a perfectly
 *     healthy stream got dropped as "delivered no video", and when it did start,
 *     the stash was pure added delay.
 *   - `lazyLoad: true` aborts the HTTP connection once 3 minutes are buffered.
 *     For live that reconnect is a fresh 302 through the gateway and a fresh
 *     stall for the viewer, buying nothing.
 * The cleanup pair keeps the SourceBuffer from growing without bound over a long
 * watch; `reuseRedirectedURL` keeps a reconnect on the signed CDN URL we were
 * already handed instead of re-running the gateway redirect.
 */
const LIVE_FLV_CONFIG = {
  enableStashBuffer: false,
  stashInitialSize: 128,
  lazyLoad: false,
  autoCleanupSourceBuffer: true,
  autoCleanupMaxBackwardDuration: 30,
  autoCleanupMinBackwardDuration: 10,
  reuseRedirectedURL: true,
} as const;

/**
 * Seconds behind the newest buffered byte before we skip forward.
 *
 * flv.js does not chase the live edge (that is mpegts.js). Without this, every
 * stall the network hands us is permanent latency: the player resumes where it
 * paused and stays that far behind for the rest of the session, so a viewer who
 * hit two stalls is minutes behind by the end. Bounded at 2s — below that the
 * skip is more visible than the delay it removes.
 */
const MAX_DRIFT_S = 2;
/** Where to land when skipping: short of the edge, or we starve immediately. */
const EDGE_MARGIN_S = 0.4;

/**
 * How long the first attempt gets to produce a frame before the audio-less
 * retry. Short on purpose: this path only exists for a stream that is already
 * broken, and every millisecond here is join delay for the viewer.
 */
const AUDIO_RETRY_MS = 2500;

/**
 * Delay behind the source this viewer is NOT able to measure, in ms:
 * encoder → ingest → CDN edge → first byte on the wire.
 *
 * The part that IS measurable — how much decoded media is sitting ahead of
 * the playhead — is read from `video.buffered` per call, so only this opaque
 * upstream leg stays a constant.
 *
 * ponytail: flat 800ms for the upstream leg. A real per-session measurement
 * would need the server to stamp wall-clock into the FLV stream (it doesn't),
 * so the honest upgrade path is an `EXT-X-PROGRAM-DATE-TIME`-style timestamp
 * from the engine, not more arithmetic here.
 */
const UPSTREAM_LATENCY_MS = 800;

/**
 * Resolves true when media has landed but playback still cannot start.
 *
 * Both halves matter. `currentTime === 0` alone is also what a slow first
 * segment looks like, and treating that as the audio-lie case drops audio for
 * the rest of the session on nothing worse than a cold CDN edge — observed
 * once, as a stream that played perfectly and silently. Buffered data with a
 * clock that will not move is the actual signature: the demuxer fed the
 * SourceBuffer and the element is still waiting for a track that never arrives.
 */
function stalledWithData(video: HTMLVideoElement, ms: number): Promise<boolean> {
  if (video.currentTime > 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (stalled: boolean) => {
      clearTimeout(timer);
      video.removeEventListener("timeupdate", onTime);
      resolve(stalled);
    };
    const onTime = () => {
      if (video.currentTime > 0) done(false);
    };
    const timer = setTimeout(() => done(video.buffered.length > 0 && video.currentTime === 0), ms);
    video.addEventListener("timeupdate", onTime);
  });
}

/**
 * Skip to the live edge when playback has fallen behind it. Exported for test;
 * a no-op when the gap is small, so it is safe on every `timeupdate`.
 */
export function chaseLiveEdge(video: HTMLVideoElement): void {
  const ranges = video.buffered;
  if (ranges.length === 0) return;
  const edge = ranges.end(ranges.length - 1);
  if (edge - video.currentTime <= MAX_DRIFT_S) return;
  video.currentTime = edge - EDGE_MARGIN_S;
}

export class FlvViewTransport implements ViewTransport {
  readonly kind = "flv_js" as const;

  private player: FlvPlayer | null = null;
  private video: HTMLVideoElement | null = null;
  private endedCb: (() => void) | null = null;
  private bufferingCb: (() => void) | null = null;
  /** Aborts this attempt's element listeners; see start(). */
  private listeners: AbortController | null = null;

  constructor(
    private readonly signaling: SignalingClient,
    private readonly deliveryPath: string,
  ) {}

  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }

  onBuffering(cb: () => void): void {
    this.bufferingCb = cb;
  }

  async start(_streamId: string, video: HTMLVideoElement): Promise<void> {
    this.video = video;
    const url = this.signaling.deliveryUrl(this.deliveryPath);

    // Bound to this attempt's lifetime. The player hands every candidate route
    // the SAME element, so listeners left behind by a route that failed keep
    // firing over the route that succeeded — and an orphaned chaseLiveEdge does
    // not just report, it SEEKS, yanking a healthy HLS playback around on behalf
    // of a dead FLV attempt. stop() aborts them.
    this.listeners = new AbortController();
    const { signal } = this.listeners;
    video.addEventListener("ended", () => this.endedCb?.(), { signal });
    video.addEventListener("waiting", () => this.bufferingCb?.(), { signal });
    video.addEventListener("timeupdate", () => chaseLiveEdge(video), { signal });

    let mod: FlvModule;
    try {
      // Literal specifier on purpose: a bundler must be able to see it and inline
      // the library into the single-file drop-in build. A computed specifier
      // leaves a bare module request in the output, which no browser can resolve.
      // Types come from internal/flv.js.d.ts.
      mod = await import("flv.js");
    } catch (cause) {
      throw mebiusError("CONNECTION_FAILED", "Balanced playback support failed to load.", cause);
    }

    const flvjs = mod.default;
    if (!flvjs.isSupported()) {
      throw mebiusError("CONNECTION_FAILED", "Balanced playback is not supported in this browser.");
    }

    this.attachPlayer(flvjs, video, url, true);
    // NOT awaited yet: video.play() only settles once playback actually begins,
    // so awaiting it here would hang on exactly the stall the retry below exists
    // to break. The outcome is collected after we know the stream moved.
    const firstPlay = playWithAutoplayFallback(video);
    firstPlay.catch(() => undefined); // the retry path is the error handler

    // Second attempt, without the audio track, when the first one never moves.
    //
    // An FLV header can claim audio the stream does not carry — a WebRTC
    // broadcast reaches the CDN as video-only (Opus cannot ride in FLV) and the
    // header still advertises audio. flv.js then holds playback forever waiting
    // for an audio init segment that never comes: metadata parses, the video
    // init segment lands, and currentTime stays at 0.
    //
    // Telling flv.js up front to ignore audio would silence every publisher that
    // DOES send AAC, so it cannot be the default — this only fires once, only
    // when the stream has demonstrably not started, and it is far cheaper than
    // the player's 8s route watchdog for a case that is otherwise unrecoverable.
    if (await stalledWithData(video, AUDIO_RETRY_MS)) {
      this.teardownPlayer();
      this.attachPlayer(flvjs, video, url, false);
      this.mutedByPolicy = (await playWithAutoplayFallback(video)).mutedByPolicy;
      return;
    }
    this.mutedByPolicy = (await firstPlay).mutedByPolicy;
  }

  private attachPlayer(
    flvjs: FlvModule["default"],
    video: HTMLVideoElement,
    url: string,
    withAudio: boolean,
  ): void {
    const player = flvjs.createPlayer(
      { type: "flv", url, isLive: true, ...(withAudio ? {} : { hasAudio: false }) },
      LIVE_FLV_CONFIG,
    );
    this.player = player;
    player.on(flvjs.Events.ERROR ?? "error", () => this.bufferingCb?.());
    player.attachMediaElement(video);
    player.load();
  }

  private teardownPlayer(): void {
    if (!this.player) return;
    this.player.unload();
    this.player.detachMediaElement();
    this.player.destroy();
    this.player = null;
  }

  /** True when playback only started because the element had to be muted. */
  mutedByPolicy = false;

  async stop(): Promise<void> {
    this.listeners?.abort();
    this.listeners = null;
    this.teardownPlayer();
    if (this.video) {
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.video = null;
  }

  /** Decoded-frame count and timestamp of the previous getStats() call. */
  private lastFrames: { count: number; atMs: number } | null = null;

  /**
   * Real playback statistics for this route.
   *
   * Both numbers used to be hardcoded zeros, which is worse than reporting
   * nothing: the dashboard cannot tell a measured 0 kbps from an unmeasured
   * one, so every flv.js viewer in production showed a downlink of 0 and the
   * column read as a total outage. flv.js measures throughput itself
   * (`statisticsInfo.speed`, KB/s), and the element counts decoded frames, so
   * frame rate is the delta between two calls. Anything genuinely unavailable
   * is left undefined rather than zeroed.
   */
  async getStats(): Promise<PlaybackStats | null> {
    if (!this.video) return null;

    const speedKBs = this.player?.statisticsInfo?.speed;
    const bitrateKbps = typeof speedKBs === "number" ? Math.round(speedKBs * 8) : undefined;

    let framesPerSecond: number | undefined;
    const q = this.video.getVideoPlaybackQuality?.();
    const count = q?.totalVideoFrames;
    const atMs = Date.now();
    if (typeof count === "number") {
      const prev = this.lastFrames;
      if (prev && atMs > prev.atMs && count >= prev.count) {
        framesPerSecond = Math.round(((count - prev.count) * 1000) / (atMs - prev.atMs));
      }
      this.lastFrames = { count, atMs };
    }

    return { bitrateKbps, framesPerSecond, latencyMs: undefined };
  }

  /**
   * Estimate — FLV carries no wall clock, so this is measured where possible
   * and assumed where not (see {@link UPSTREAM_LATENCY_MS}).
   *
   * The measurable half is the decoded media queued ahead of the playhead:
   * whatever is buffered but not yet shown is, by definition, how far behind
   * the newest received frame this viewer is watching. A flat guess for the
   * whole delay was previously used, and being too generous costs real time —
   * every millisecond of over-estimate is a caption withheld for no reason,
   * on top of the STT latency the viewer already pays.
   */
  playheadEpochMs(): number | null {
    let bufferedAheadMs = 0;
    const ranges = this.video?.buffered;
    if (ranges && ranges.length > 0 && this.video) {
      const ahead = ranges.end(ranges.length - 1) - this.video.currentTime;
      // Negative means the element reports a playhead past its own buffer,
      // which is a transient during a seek, not a real negative latency.
      if (Number.isFinite(ahead) && ahead > 0) bufferedAheadMs = ahead * 1000;
    }
    return Date.now() - UPSTREAM_LATENCY_MS - bufferedAheadMs;
  }
}
