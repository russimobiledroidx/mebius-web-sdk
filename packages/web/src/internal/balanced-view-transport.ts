/**
 * INTERNAL — balanced view transport (HTTP-FLV via flv.js).
 *
 * For typical one-to-many web viewers Mebius pulls an HTTP-FLV stream and feeds
 * it through flv.js (Media Source Extensions). Latency is ~1-3s — lower than
 * HLS, higher than the WebRTC pull — and it scales over a CDN edge. flv.js is
 * loaded lazily so it never weighs down apps that don't use this mode.
 *
 * Browser-only: flv.js needs MSE, which iOS Safari lacks. Hidden from the
 * public API; the public surface speaks only of the `"balanced"` playback mode.
 */
import type { PlaybackStats } from "../types.js";
import { mebiusError } from "../errors.js";
import type { SignalingClient } from "./signaling.js";
import type { ViewTransport } from "./transport.js";

// Minimal structural typing for the parts of flv.js we use, declared locally so
// this package type-checks WITHOUT flv.js installed (it is an optional
// dependency the host app provides).
interface FlvPlayer {
  attachMediaElement(el: HTMLVideoElement): void;
  load(): void;
  play(): Promise<void> | void;
  unload(): void;
  detachMediaElement(): void;
  destroy(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}
interface FlvModule {
  isSupported(): boolean;
  createPlayer(config: { type: string; url: string; isLive?: boolean }): FlvPlayer;
  Events: Record<string, string>;
}

export class FlvViewTransport implements ViewTransport {
  private player: FlvPlayer | null = null;
  private video: HTMLVideoElement | null = null;
  private endedCb: (() => void) | null = null;
  private bufferingCb: (() => void) | null = null;

  constructor(private readonly signaling: SignalingClient) {}

  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }

  onBuffering(cb: () => void): void {
    this.bufferingCb = cb;
  }

  async start(streamId: string, video: HTMLVideoElement): Promise<void> {
    this.video = video;
    const url = this.signaling.balancedStreamUrl(streamId);

    video.addEventListener("ended", () => this.endedCb?.());
    video.addEventListener("waiting", () => this.bufferingCb?.());

    let mod: { default: FlvModule };
    try {
      // Non-literal specifier so the optional dependency is resolved at runtime
      // and does not break type-checking when it is not installed.
      const spec = "flv.js";
      mod = (await import(/* @vite-ignore */ spec)) as { default: FlvModule };
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
    await Promise.resolve(player.play()).catch(() => undefined);
  }

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
