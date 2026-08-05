/**
 * Public type surface for the Mebius Web SDK.
 *
 * Nothing here references how media is actually moved across the network — the
 * SDK speaks only in Mebius terms. Transport details live in `internal/`.
 */

/** Options for {@link Mebius.init}. */
export interface MebiusInitOptions {
  /** Your Mebius application id. */
  appId: string;
  /**
   * The Mebius gateway (signaling endpoint) base URL, e.g.
   * `https://gateway.mebius.io`. This is the only endpoint the SDK ever talks
   * to. HTTPS is required in production.
   */
  gateway: string;
}

/**
 * One playback route Mebius has prepared for a stream, as returned alongside the
 * token by your backend. Pass the list through untouched — Mebius orders it and
 * picks from it. `kind` is a Mebius intent label, not a format: treat both fields
 * as opaque.
 */
export interface MebiusDelivery {
  /** Mebius intent label, e.g. `"fast"` or `"wide"`. Opaque to your app. */
  kind: string;
  /** A Mebius-relative path. Opaque to your app; Mebius resolves it. */
  path: string;
}

/** Options for {@link Mebius.connect}. */
export interface MebiusConnectOptions {
  /**
   * A short-lived token minted by YOUR backend from (appId + appSecret).
   * The app secret must never be embedded in client code.
   */
  token: string;
  /**
   * The `deliveries` list your backend received together with the token. Pass it
   * through as-is and Mebius will pick the best route for each viewer's device,
   * falling back automatically if one stops delivering frames.
   *
   * Optional: without it playback still works, but every viewer is served from
   * Mebius origin rather than the nearest edge.
   */
  deliveries?: MebiusDelivery[];
}

/** A media capture constraint: enable/disable, or a detailed constraint set. */
export type MediaConstraint = boolean | MediaTrackConstraints;

/** Options for {@link MebiusClient.createBroadcaster}. */
export interface BroadcasterOptions {
  /** Capture video. Defaults to `true`. */
  video?: MediaConstraint;
  /** Capture audio. Defaults to `true`. */
  audio?: MediaConstraint;
}

/**
 * Playback mode.
 * - `"auto"` — recommended. Mebius picks per viewer and falls back on its own.
 * - `"low-latency"` — minimal (sub-second) delay, best for interactive/real-time
 *   viewing. Web browsers only.
 * - `"balanced"` — a low delay that still scales to a large audience. Web
 *   browsers with Media Source support (i.e. not iOS Safari).
 * - `"scale"` — optimized for the largest audiences; higher delay. Plays on
 *   every platform, including iOS Safari.
 *
 * Mebius picks the right delivery method for each mode automatically.
 */
// Maintainer note (not shipped as guidance to clients): "balanced" was deleted in
// 0.2.0 on the reading that the gateway served no route for it. The route had
// simply not been built — production web playback was always this path. It is back
// now that the gateway serves it. "auto" is the mode to prefer going forward: the
// gateway already knows which routes are live and what each costs to serve.
export type PlaybackMode = "auto" | "low-latency" | "balanced" | "scale";

/** Options for {@link MebiusClient.createPlayer}. */
export interface PlayerOptions {
  /** Defaults to `"auto"` — let Mebius choose per viewer. */
  mode?: PlaybackMode;
}

/**
 * Where a player renders video: a `<video>` element, or a CSS selector that
 * resolves to one.
 */
export type ViewTarget = HTMLVideoElement | string;

/** Live broadcast statistics, emitted periodically on the `"stats"` event. */
export interface BroadcastStats {
  /** Outbound bitrate in kilobits per second. */
  bitrateKbps: number;
  /** Frames per second currently being sent. */
  framesPerSecond: number;
  /** Round-trip time to the gateway in milliseconds, if known. */
  rttMs?: number;
}

/** Live playback statistics, emitted periodically on the `"stats"` event. */
export interface PlaybackStats {
  /** Inbound bitrate in kilobits per second. */
  bitrateKbps: number;
  /** Frames per second currently being rendered. */
  framesPerSecond: number;
  /** Estimated end-to-end latency in milliseconds, if known. */
  latencyMs?: number;
}

/** Canonical Mebius error codes surfaced to your app. */
export type MebiusErrorCode =
  | "TOKEN_EXPIRED"
  | "PERMISSION_DENIED"
  | "CONNECTION_FAILED"
  | "NOT_CONNECTED"
  | "STREAM_NOT_FOUND"
  | "UNKNOWN";
