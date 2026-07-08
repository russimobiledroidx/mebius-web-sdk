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
export { MebiusError, mebiusError } from "./errors.js";

export type {
  ClientEventMap,
  BroadcasterEventMap,
  PlayerEventMap,
} from "./events.js";

export type {
  MebiusInitOptions,
  MebiusConnectOptions,
  BroadcasterOptions,
  PlayerOptions,
  PlaybackMode,
  ViewTarget,
  MediaConstraint,
  BroadcastStats,
  PlaybackStats,
  MebiusErrorCode,
} from "./types.js";
