/**
 * Public types for @mebius-io/react-native.
 *
 * Identical contract to @mebius-io/web (same names), kept local so this package
 * carries no browser dependency. Transport details are never named here.
 */
export interface MebiusInitOptions {
  appId: string;
  gateway: string;
}
export interface MebiusDelivery {
  /** Mebius intent label. Opaque to your app. */
  kind: string;
  /** Mebius-relative path. Opaque to your app; Mebius resolves it. */
  path: string;
}
export interface MebiusConnectOptions {
  token: string;
  /**
   * The `deliveries` list your backend received with the token. Pass it through
   * as-is: without it, every viewer is served from Mebius origin instead of the
   * nearest edge, which on mobile is the difference between a per-viewer cost and
   * no per-viewer cost at all.
   */
  deliveries?: MebiusDelivery[];
}
export interface BroadcasterOptions {
  video?: boolean;
  audio?: boolean;
}
/**
 * `"auto"` lets Mebius choose. `"balanced"` (from @mebius-io/web) is absent here on
 * purpose: it needs Media Source Extensions, which React Native has no equivalent
 * of, so declaring it would be a mode that could never play.
 */
export type PlaybackMode = "auto" | "low-latency" | "scale";
export interface PlayerOptions {
  /** Defaults to `"auto"`. */
  mode?: PlaybackMode;
}
export interface BroadcastStats {
  bitrateKbps: number;
  framesPerSecond: number;
  rttMs?: number;
}
export interface PlaybackStats {
  bitrateKbps: number;
  framesPerSecond: number;
  latencyMs?: number;
}
export type MebiusErrorCode =
  | "TOKEN_EXPIRED"
  | "PERMISSION_DENIED"
  | "CONNECTION_FAILED"
  | "NOT_CONNECTED"
  | "STREAM_NOT_FOUND"
  | "NOT_IMPLEMENTED"
  | "UNKNOWN";
