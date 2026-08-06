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
import { playWithAutoplayFallback } from "./autoplay.js";

// Loaded on demand so it never weighs down low-latency-only apps.
type HlsModule = typeof import("hls.js");
type HlsInstance = import("hls.js").default;

export class HlsViewTransport implements ViewTransport {
  private hls: HlsInstance | null = null;
  private video: HTMLVideoElement | null = null;
  private endedCb: (() => void) | null = null;
  private bufferingCb: (() => void) | null = null;
  /** Aborts this attempt's element listeners; see start(). */
  private listeners: AbortController | null = null;

  /**
   * deliveryPath, when given, is a gateway-relative path from the gateway's own
   * delivery list — that is how a CDN-backed playlist gets used instead of the
   * origin one. Without it this falls back to the origin playlist, which is
   * still correct, just served from our own bandwidth.
   */
  constructor(
    private readonly signaling: SignalingClient,
    private readonly deliveryPath?: string,
  ) {}

  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }

  onBuffering(cb: () => void): void {
    this.bufferingCb = cb;
  }

  async start(streamId: string, video: HTMLVideoElement): Promise<void> {
    this.video = video;
    const url = this.deliveryPath
      ? this.signaling.deliveryUrl(this.deliveryPath)
      : this.signaling.scalePlaylistUrl(streamId);

    // Same reason as the FLV route: every candidate shares one element, so a
    // failed attempt's listeners must not outlive it.
    this.listeners = new AbortController();
    const { signal } = this.listeners;
    video.addEventListener("ended", () => this.endedCb?.(), { signal });
    video.addEventListener("waiting", () => this.bufferingCb?.(), { signal });

    // Safari and iOS play HLS natively — no library needed.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      this.mutedByPolicy = (await playWithAutoplayFallback(video)).mutedByPolicy;
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

    // No forced lowLatencyMode: it is for LL-HLS playlists (EXT-X-PART), and
    // asserting it against an ordinary playlist makes hls.js wait for parts that
    // never arrive. hls.js turns it on by itself when the playlist advertises it.
    // maxLiveSyncPlaybackRate lets hls.js catch up by playing slightly fast when
    // it has drifted behind the live edge. Default is 1 — no catching up ever, so
    // every stall becomes permanent added latency for the rest of the session.
    const hls = new Hls({ maxLiveSyncPlaybackRate: 1.5 });
    this.hls = hls;
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) this.bufferingCb?.();
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    this.mutedByPolicy = (await playWithAutoplayFallback(video)).mutedByPolicy;
  }

  /** True when playback only started because the element had to be muted. */
  mutedByPolicy = false;

  async stop(): Promise<void> {
    this.listeners?.abort();
    this.listeners = null;
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
