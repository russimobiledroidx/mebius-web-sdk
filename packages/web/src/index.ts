/**
 * @mebius-io/web — Mebius Client SDK for the web.
 *
 * Public surface only. Everything under `internal/` is private and is never
 * re-exported here.
 */
export { Mebius } from "./mebius.js";
export { MebiusClient } from "./client.js";
export { MebiusBroadcaster } from "./broadcaster.js";
export { MebiusPlayer } from "./player.js";
export { MebiusCaptions } from "./captions.js";
export { MebiusError, mebiusError } from "./errors.js";

export type {
  ClientEventMap,
  BroadcasterEventMap,
  PlayerEventMap,
  CaptionsEventMap,
} from "./events.js";

export type {
  MebiusInitOptions,
  MebiusConnectOptions,
  MebiusDelivery,
  BroadcasterOptions,
  PlayerOptions,
  PlaybackMode,
  ViewTarget,
  MediaConstraint,
  BroadcastStats,
  PlaybackStats,
  CaptionsOptions,
  CaptionSegment,
  MebiusErrorCode,
} from "./types.js";
