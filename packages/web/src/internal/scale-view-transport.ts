/**
 * INTERNAL — scale view transport (HLS via hls.js / native).
 *
 * For large-audience playback Mebius delivers an HLS playlist from the
 * gateway. hls.js is loaded lazily; Safari plays the playlist natively.
 * Hidden from the public API.
 */
import type { PlaybackStats } from "../types.js";
import { mebiusError } from "../errors.js";
import type { SignalingClient } from "./signaling.js";
import type { ViewTransport } from "./transport.js";

// Loaded on demand so it never weighs down low-latency-only apps.
type HlsModule = typeof import("hls.js");
type HlsInstance = import("hls.js").default;

export class HlsViewTransport implements ViewTransport {
  private hls: HlsInstance | null = null;
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
    const url = this.signaling.scalePlaylistUrl(streamId);

    video.addEventListener("ended", () => this.endedCb?.());
    video.addEventListener("waiting", () => this.bufferingCb?.());

    // Safari and iOS play HLS natively — no library needed.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      await video.play().catch(() => undefined);
      return;
    }

    let mod: HlsModule;
    try {
      mod = await import("hls.js");
    } catch (cause) {
      throw mebiusError("CONNECTION_FAILED", "Scale playback support failed to load.", cause);
    }
    const Hls = mod.default;
    if (!Hls.isSupported()) {
      throw mebiusError("CONNECTION_FAILED", "Scale playback is not supported in this browser.");
    }

    const hls = new Hls({ lowLatencyMode: true });
    this.hls = hls;
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) this.bufferingCb?.();
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    await video.play().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.hls?.destroy();
    this.hls = null;
    if (this.video) {
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.video = null;
  }

  async getStats(): Promise<PlaybackStats | null> {
    if (!this.video) return null;
    const level = this.hls?.levels?.[this.hls.currentLevel];
    return {
      bitrateKbps: level ? Math.round(level.bitrate / 1000) : 0,
      framesPerSecond: 0,
    };
  }
}
