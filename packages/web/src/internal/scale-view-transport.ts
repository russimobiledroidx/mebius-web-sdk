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

/**
 * Retry predicate for the playlist load. Exported for its test only.
 *
 * A 404 on a live playlist is usually a TIMING answer, not a permanent one: a CDN
 * edge only packages HLS once ingest has produced segments, so a viewer joining in
 * the first ~10s asks for a playlist that does not exist yet. hls.js never retries
 * a 4xx on its own (retryForHttpStatus excludes 400-499), so without this the
 * retry budget is dead config against the exact status the edge returns.
 *
 * 404 only — 401/403 means the play token is wrong, and retrying that is noise.
 */
export function retryWarmupNotFound(
  cfg: { maxNumRetry?: number } | null | undefined,
  retryCount: number,
  res: { code?: number } | undefined,
  retry: boolean,
): boolean {
  return retry || (retryCount < (cfg?.maxNumRetry ?? 0) && res?.code === 404);
}

export class HlsViewTransport implements ViewTransport {
  readonly kind = "hls" as const;

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

    // Media Source first, native second — NOT the other way round.
    //
    // The check used to be `if (video.canPlayType("application/vnd.apple.mpegurl"))`,
    // and Chromium answers "maybe" to that. "maybe" is a legal answer meaning
    // "I might, ask me again with codecs", and Chromium says it while being
    // unable to play a playlist at all — so this route assigned video.src and
    // died with "NotSupportedError: Failed to load because no supported source
    // was found", on the browser most viewers use. Asking the library whether
    // it can drive this browser is a direct question with a direct answer;
    // canPlayType is neither.
    let Hls: HlsModule["default"] | null = null;
    try {
      Hls = (await import("hls.js")).default;
    } catch {
      // Bundling or network problem. Native is then the only chance, and Safari
      // is exactly the browser where it works.
      Hls = null;
    }

    if (!Hls?.isSupported()) {
      if (!video.canPlayType("application/vnd.apple.mpegurl")) {
        throw mebiusError("CONNECTION_FAILED", "Scale playback is not supported in this browser.");
      }
      video.src = url;
      this.mutedByPolicy = (await playWithAutoplayFallback(video)).mutedByPolicy;
      return;
    }

    // No forced lowLatencyMode: it is for LL-HLS playlists (EXT-X-PART), and
    // asserting it against an ordinary playlist makes hls.js wait for parts that
    // never arrive. hls.js turns it on by itself when the playlist advertises it.
    //
    // maxLiveSyncPlaybackRate lets hls.js catch up by playing fast when it has
    // drifted behind the live edge. Default is 1 — no catching up ever, so every
    // stall becomes permanent added latency for the rest of the session.
    //
    // 1.1, not 1.5. Catch-up is a pitch shift on the audio, and 1.5 is a 50%
    // one: viewers hear it as chipmunk speech, which is worse than the latency it
    // buys back. It also fights itself on an LL-HLS playlist, where the target is
    // PART-HOLD-BACK (0.5s here) — any network jitter reads as "behind", so the
    // player spends the session alternating between sprinting and starving.
    // 1.1 is inaudible and still recovers a 2s drift in ~20s.
    // Everything else is left at hls.js defaults on purpose: it already reads the
    // server's own HOLD-BACK / PART-HOLD-BACK target from the playlist, and a
    // number guessed here would only override a value the server measured.
    // Manifest retry, because a 404 on the playlist is usually a TIMING answer,
    // not a permanent one: a CDN edge only packages HLS once ingest has produced
    // segments, so a viewer who joins in the first ~10s of a stream asks for a
    // playlist that does not exist yet. hls.js defaults to 1 retry, which turns
    // that warm-up window into a hard candidate failure. 5 retries with backoff
    // capped at 2s covers ~10s of warm-up and costs nothing once the edge is hot.
    // See retryWarmupNotFound for why the predicate is mandatory, not decoration.
    const hls = new Hls({
      maxLiveSyncPlaybackRate: 1.1,
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 10_000,
          maxLoadTimeMs: 20_000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: {
            maxNumRetry: 5,
            retryDelayMs: 500,
            maxRetryDelayMs: 2_000,
            shouldRetry: (cfg, retryCount, _isTimeout, res, retry) =>
              retryWarmupNotFound(cfg, retryCount, res, retry),
          },
        },
      },
    });
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

  /**
   * hls.js exposes `playingDate` straight from the segment the element is
   * currently rendering, derived from the playlist's `EXT-X-PROGRAM-DATE-TIME`
   * (MediaMTX writes it). Safari's native player has no such property, but
   * `getStartDate()` (the wall-clock time of the playlist's first segment) plus
   * elapsed `currentTime` is the same clock by construction.
   */
  playheadEpochMs(): number | null {
    if (this.hls) return this.hls.playingDate?.getTime() ?? null;
    // getStartDate() is a real, shipped HTMLMediaElement method (used by Safari
    // for exactly this) that TS's bundled DOM lib does not declare.
    const video = this.video as (HTMLVideoElement & { getStartDate?: () => Date }) | null;
    if (video?.getStartDate) {
      const start = video.getStartDate().getTime();
      if (Number.isFinite(start)) return start + video.currentTime * 1000;
    }
    return null;
  }
}
