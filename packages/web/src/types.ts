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

/** Options for {@link Mebius.connect}. */
export interface MebiusConnectOptions {
  /**
   * A short-lived token minted by YOUR backend from (appId + appSecret).
   * The app secret must never be embedded in client code.
   */
  token: string;
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
 * - `"low-latency"` — minimal (sub-second) delay, best for interactive/real-time
 *   viewing. Web browsers only.
 * - `"balanced"` — low delay (~1-3s) with broad scalability, best for typical
 *   one-to-many web viewers. Web browsers only (not supported on iOS Safari).
 * - `"scale"` — optimized for the largest audiences; higher delay. Plays on
 *   every platform, including iOS Safari.
 *
 * Mebius picks the right delivery method for each mode automatically.
 */
export type PlaybackMode = "low-latency" | "balanced" | "scale";

/** Options for {@link MebiusClient.createPlayer}. */
export interface PlayerOptions {
  mode: PlaybackMode;
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
