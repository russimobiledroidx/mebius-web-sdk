/**
 * INTERNAL — transport interfaces + auto-selection.
 *
 * The public API never names a transport; it only asks for a playback *mode*.
 * This factory maps a mode to the right hidden delivery mechanism.
 */
import type { BroadcastStats, MebiusDelivery, PlaybackMode, PlaybackStats } from "../types.js";
import type { SignalingClient } from "./signaling.js";
import { WhipPublishTransport } from "./publish-transport.js";
import { WhepViewTransport } from "./ll-view-transport.js";
import { HlsViewTransport } from "./scale-view-transport.js";
import { FlvViewTransport } from "./balanced-view-transport.js";

/** Hidden transport that sends a captured stream to the gateway. */
export interface PublishTransport {
  start(streamId: string, stream: MediaStream): Promise<void>;
  stop(): Promise<void>;
  getStats(): Promise<BroadcastStats | null>;
  /** Swap the outgoing video track in place (e.g. on camera switch). */
  replaceVideoTrack(track: MediaStreamTrack | null): Promise<void>;
}

/**
 * Wire name of a playback transport, reported with telemetry.
 *
 * The dashboard has a "player" column and nothing ever filled it — the SDK sent
 * no such field, so the backend defaulted every viewer session to `flv_js`
 * whatever had actually played it. The route chosen is exactly the sort of
 * thing that explains a bad session, so it is worth one string per batch.
 */
export type ViewTransportKind = "whep" | "flv_js" | "hls";

/** Hidden transport that renders a remote stream into a video element. */
export interface ViewTransport {
  /** Which mechanism this is, for telemetry. Never shown to the viewer. */
  readonly kind: ViewTransportKind;
  start(streamId: string, video: HTMLVideoElement): Promise<void>;
  stop(): Promise<void>;
  getStats(): Promise<PlaybackStats | null>;
  /** Fired by the transport when playback reaches its natural end. */
  onEnded(cb: () => void): void;
  /** Fired when the transport (re)enters a buffering state. */
  onBuffering(cb: () => void): void;
  /**
   * Wall-clock time (Unix ms) the viewer is currently watching, if this route
   * can produce one. Captions compare this against the engine's `epochMs` to
   * decide when a segment is due — `video.currentTime` cannot be used for that,
   * it counts from the start of playback, not from a shared clock.
   *
   * Absent (rather than a guess) on a route with no such signal: showing a
   * caption at the wrong moment is worse than showing it late.
   */
  playheadEpochMs?(): number | null;
}

export function createPublishTransport(signaling: SignalingClient): PublishTransport {
  return new WhipPublishTransport(signaling);
}

/**
 * Delivery kinds the gateway may offer. Neutral by design — the gateway names
 * an intent ("fast", "wide"), never a protocol, and this module is the only
 * place that decides which transport serves which intent. That is what lets the
 * gateway change protocol without an SDK release.
 */
const KIND_FAST = "fast";
const KIND_WIDE = "wide";
const KIND_LOCAL = "local";

/** True when this browser can play a Media-Source-based stream (not iOS Safari). */
function canPlayBuffered(): boolean {
  return typeof MediaSource !== "undefined";
}

function transportFor(
  kind: string,
  path: string,
  signaling: SignalingClient,
): ViewTransport | null {
  if (kind === KIND_FAST) return canPlayBuffered() ? new FlvViewTransport(signaling, path) : null;
  if (kind === KIND_WIDE || kind === KIND_LOCAL) return new HlsViewTransport(signaling, path);
  // An unknown kind is a newer gateway talking to an older SDK. Skip it rather
  // than guess: the list is ordered, so the next entry is the intended fallback.
  return null;
}

/**
 * Ordered list of transports to try for a playback mode, most-preferred first.
 *
 * Returning a LIST rather than one transport is the whole point: a transport can
 * connect and still deliver no frames (a CDN edge with no ingest yet, MSE
 * failing mid-init, WebRTC reporting `connected` with zero frames). The player
 * walks this list on a watchdog, so a dead first choice degrades instead of
 * showing a black frame.
 *
 * `deliveries` comes from the gateway and is already in the gateway's preferred
 * order; ordering policy therefore lives server-side, not here.
 */
export function createViewCandidates(
  mode: PlaybackMode,
  signaling: SignalingClient,
  deliveries: readonly MebiusDelivery[] = [],
): ViewTransport[] {
  const fromGateway = (kinds: readonly string[]): ViewTransport[] =>
    deliveries
      .filter((d) => kinds.includes(d.kind))
      .map((d) => transportFor(d.kind, d.path, signaling))
      .filter((t): t is ViewTransport => t !== null);

  // Every mode ends with the origin playlist, reachable with no delivery list at
  // all. Without this, a caller that never passes `deliveries` (every 0.x
  // integration today) would get an empty candidate list and fail to play.
  const originFallback = new HlsViewTransport(signaling);
  const allKinds = [KIND_FAST, KIND_WIDE, KIND_LOCAL];

  switch (mode) {
    case "low-latency":
      // The real-time pull is not in `deliveries` — it is signaled, not fetched.
      return [new WhepViewTransport(signaling), ...fromGateway(allKinds), originFallback];
    case "balanced":
      return [...fromGateway(allKinds), originFallback];
    case "scale":
      return [...fromGateway([KIND_WIDE, KIND_LOCAL]), originFallback];
    case "auto":
      // Take the gateway ordering verbatim: it knows which paths are actually
      // serving and what each one costs to serve.
      return [...fromGateway(allKinds), originFallback];
  }
}

/**
 * Single-transport selection, kept for callers written against 0.1/0.2.
 * @deprecated Use {@link createViewCandidates} — a single transport cannot fall
 * back, so a dead delivery becomes a black frame.
 */
export function createViewTransport(
  mode: PlaybackMode,
  signaling: SignalingClient,
): ViewTransport {
  return createViewCandidates(mode, signaling)[0]!;
}
