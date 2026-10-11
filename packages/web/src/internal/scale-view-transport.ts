/**
 * INTERNAL — scale view transport (HLS via hls.js / native).
 *
 * For large-audience playback Mebius delivers an HLS playlist from the
 * gateway. hls.js is loaded lazily; Safari plays the playlist natively.
 * Hidden from the public API.
 */
import type { MebiusQuality, MebiusRendition, PlaybackStats, QualityChange } from "../types.js";
import { mebiusError } from "../errors.js";
import type { SignalingClient } from "./signaling.js";
import { pickRung, toQuality, type ViewTransport } from "./transport.js";
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

/** Matches a `token=` query parameter and captures its `?`/`&` prefix. */
const TOKEN_PARAM = /([?&]token=)[^&#]*/;

/**
 * Re-stamp a URL with the current access token. Exported for its test only.
 *
 * REPLACES an existing `token` parameter, never adds one. That rule is what
 * makes this safe on a delivery route: the gateway redirects those to an edge
 * whose URLs carry the edge's own signature and no `token` of ours, and
 * appending one there would hand our access token to a host we did not choose.
 */
export function withCurrentToken(url: string, token: string): string {
  return url.replace(TOKEN_PARAM, (_match, prefix: string) => prefix + encodeURIComponent(token));
}

/**
 * A loader that re-stamps every request with the token the session holds RIGHT
 * NOW, rather than the one it held when playback started.
 *
 * This is the half of token refresh that the signaling client cannot do. Scale
 * playback hands one playlist URL to the media library and then never speaks to
 * it again: the library re-fetches that playlist every few seconds and pulls
 * segments off it for as long as the viewer watches. Swapping the session token
 * therefore changes nothing on this route — every one of those requests still
 * carries the original token, and they all start failing the moment it expires.
 * Rewriting at load time is the only point where a long watch can pick up a new
 * credential without tearing the player down and re-buffering.
 */
function tokenRestampingLoader(
  Hls: HlsModule["default"],
  currentToken: () => string,
): HlsConfigLoader {
  const Base = Hls.DefaultConfig.loader as unknown as LoaderCtor;
  return class TokenRestampingLoader extends Base {
    override load(context: { url: string }, config: unknown, callbacks: unknown): void {
      context.url = withCurrentToken(context.url, currentToken());
      super.load(context, config, callbacks);
    }
  } as unknown as HlsConfigLoader;
}

/** Structural shape of the media library's loader, kept local to this file. */
type LoaderCtor = new (config: unknown) => {
  load(context: { url: string }, config: unknown, callbacks: unknown): void;
};
type HlsConfigLoader = import("hls.js").HlsConfig["loader"];

export class HlsViewTransport implements ViewTransport {
  readonly kind = "hls" as const;

  private hls: HlsInstance | null = null;
  private video: HTMLVideoElement | null = null;
  private endedCb: (() => void) | null = null;
  private bufferingCb: (() => void) | null = null;
  /** Aborts this attempt's element listeners; see start(). */
  private listeners: AbortController | null = null;
  private qualityCb: ((change: QualityChange) => void) | null = null;
  /** `"auto"` or a rung id. Survives stop(), so a recovered route keeps the pick. */
  private selected = "auto";
  private maxHeight = Infinity;
  /** The playlist start() opened — the master, on a laddered `wide` delivery. */
  private url: string | null = null;

  /**
   * deliveryPath, when given, is a gateway-relative path from the gateway's own
   * delivery list — that is how a CDN-backed playlist gets used instead of the
   * origin one. Without it this falls back to the origin playlist, which is
   * still correct, just served from our own bandwidth.
   */
  constructor(
    private readonly signaling: SignalingClient,
    private readonly deliveryPath?: string,
    private readonly targetS?: number,
    /**
     * The delivery's ladder. On hls.js the master playlist already lists the
     * same rungs as levels; this is what names them (matched by height) and
     * what native playback switches between. Empty: no ladder, nothing changes.
     */
    private readonly renditions: readonly MebiusRendition[] = [],
  ) {}

  onQualityChanged(cb: (change: QualityChange) => void): void {
    this.qualityCb = cb;
  }

  /** Rungs the playlist actually carries, once hls.js has read it. */
  qualities(): readonly MebiusQuality[] {
    const levels = this.hls?.levels ?? [];
    return this.renditions
      .filter((r) => levels.length === 0 || levels.some((l) => l.height === r.height))
      .map(toQuality);
  }

  currentQuality(): QualityChange {
    const auto = this.selected === "auto";
    if (!this.hls) return { id: this.nativeRung()?.id ?? null, auto };
    const height = this.hls.levels?.[this.hls.currentLevel]?.height;
    return { id: this.renditions.find((r) => r.height === height)?.id ?? null, auto };
  }

  /**
   * hls.js switches level in place; native playback has no level API, so a pick
   * there reopens the element on that rung's own playlist (`"auto"` goes back
   * to the master and Safari's own ABR).
   */
  async setQuality(id: string): Promise<void> {
    this.selected = id;
    if (this.hls) {
      this.hls.currentLevel = id === "auto" ? -1 : this.levelOf(id);
      // Announces the new mode now; LEVEL_SWITCHED announces again once the
      // picture actually changes rung.
      this.qualityCb?.(this.currentQuality());
      return;
    }
    await this.reopenNative();
  }

  setMaxQuality(height: number): void {
    this.maxHeight = height;
    if (this.hls) this.applyCap();
    else if (this.selected === "auto") void this.reopenNative();
  }

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
      // Native playback takes the URL once and re-fetches the playlist itself,
      // with no hook to re-stamp it — so a token refresh cannot reach this path.
      // A session here lives as long as its token, which is why the gateway-side
      // credential lifetime still matters for browsers that land on it.
      this.url = url;
      video.src = this.nativeUrl();
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
      loader: tokenRestampingLoader(Hls, () => this.signaling.accessToken()),
      // Only when the app actually asked. Left alone, the library follows the
      // playlist's own HOLD-BACK, which the server measured from the segments it
      // is producing — a number guessed here would only override a real one.
      ...(this.targetS === undefined ? {} : { liveSyncDuration: this.targetS }),
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
    if (this.renditions.length > 0) {
      // Levels only exist once the master is parsed; a cap or pick made before
      // that (or carried over from a previous open) is applied here.
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.applyCap();
        if (this.selected !== "auto") hls.currentLevel = this.levelOf(this.selected);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, () => this.qualityCb?.(this.currentQuality()));
    }
    hls.loadSource(url);
    hls.attachMedia(video);
    this.mutedByPolicy = (await playWithAutoplayFallback(video)).mutedByPolicy;
  }

  /** hls.js level index for a rung id, matched by height; -1 (auto) if absent. */
  private levelOf(id: string): number {
    const height = this.renditions.find((r) => r.id === id)?.height;
    return this.hls?.levels?.findIndex((l) => l.height === height) ?? -1;
  }

  /** `autoLevelCapping` = the highest level within maxHeight (the lowest if none fits). */
  private applyCap(): void {
    const levels = this.hls?.levels;
    if (!this.hls || !levels?.length || this.renditions.length === 0) return;
    const byHeight = levels.map((l, i) => ({ height: l.height, i })).sort((a, b) => b.height - a.height);
    this.hls.autoLevelCapping = Number.isFinite(this.maxHeight)
      ? (byHeight.find((l) => l.height <= this.maxHeight) ?? byHeight[byHeight.length - 1]!).i
      : -1;
  }

  /**
   * The rung native playback should be pinned to, or `null` for the master.
   * Native ABR cannot be capped, so under `"auto"` a cap below the top rung
   * pins the highest rung under it instead — no ABR, but never above the cap.
   */
  private nativeRung(): MebiusRendition | null {
    const top = Math.max(...this.renditions.map((r) => r.height));
    if (this.selected === "auto" && top <= this.maxHeight) return null;
    return pickRung(this.renditions, this.selected, this.maxHeight);
  }

  private nativeUrl(): string {
    const rung = this.nativeRung();
    return rung ? this.signaling.deliveryUrl(rung.path) : (this.url ?? "");
  }

  /** Native only: point the element at the playlist the selection now calls for. */
  private async reopenNative(): Promise<void> {
    const video = this.video;
    if (!video || !this.url || this.renditions.length === 0) return;
    const next = this.nativeUrl();
    if (video.src !== next) {
      video.src = next;
      await playWithAutoplayFallback(video).catch(() => undefined);
    }
    this.qualityCb?.(this.currentQuality());
  }

  /** True when playback only started because the element had to be muted. */
  mutedByPolicy = false;

  async stop(): Promise<void> {
    this.listeners?.abort();
    this.listeners = null;
    this.hls?.destroy();
    this.hls = null;
    this.url = null;
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
