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

    const player = flvjs.createPlayer({ type: "flv", url, isLive: true });
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
