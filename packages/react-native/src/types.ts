/**
 * Public types for @mebius/react-native.
 *
 * Identical contract to @mebius/web (same names), kept local so this package
 * carries no browser dependency. Transport details are never named here.
 */
export interface MebiusInitOptions {
  appId: string;
  gateway: string;
}
export interface MebiusConnectOptions {
  token: string;
}
export interface BroadcasterOptions {
  video?: boolean;
  audio?: boolean;
}
export type PlaybackMode = "low-latency" | "scale";
export interface PlayerOptions {
  mode: PlaybackMode;
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
