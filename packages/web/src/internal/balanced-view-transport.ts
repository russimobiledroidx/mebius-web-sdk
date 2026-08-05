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
  private player: FlvPlayer | null = null;
  private video: HTMLVideoElement | null = null;
  private endedCb: (() => void) | null = null;
  private bufferingCb: (() => void) | null = null;

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

    video.addEventListener("ended", () => this.endedCb?.());
    video.addEventListener("waiting", () => this.bufferingCb?.());
    video.addEventListener("timeupdate", () => chaseLiveEdge(video));

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

    const player = flvjs.createPlayer({ type: "flv", url, isLive: true }, LIVE_FLV_CONFIG);
    this.player = player;
    player.on(flvjs.Events.ERROR ?? "error", () => this.bufferingCb?.());
    player.attachMediaElement(video);
    player.load();
    // flv.js delegates to the element, so the same autoplay policy applies.
    this.mutedByPolicy = (await playWithAutoplayFallback(video)).mutedByPolicy;
  }

  /** True when playback only started because the element had to be muted. */
  mutedByPolicy = false;

  async stop(): Promise<void> {
    if (this.player) {
      this.player.unload();
      this.player.detachMediaElement();
      this.player.destroy();
      this.player = null;
    }
    if (this.video) {
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.video = null;
  }

  async getStats(): Promise<PlaybackStats | null> {
    if (!this.video) return null;
    return {
      bitrateKbps: 0,
      framesPerSecond: 0,
      latencyMs: undefined,
    };
  }
}
