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
export { MebiusScreenViewer } from "./screen-viewer.js";
export { MebiusScreenShare } from "./screen-share.js";
export { MebiusError, mebiusError } from "./errors.js";

export type {
  ClientEventMap,
  BroadcasterEventMap,
  PlayerEventMap,
  CaptionsEventMap,
  ScreenViewerEventMap,
  ScreenShareEventMap,
} from "./events.js";

export type {
  MebiusInitOptions,
  MebiusConnectOptions,
  MebiusDelivery,
  MebiusRendition,
  BroadcasterOptions,
  PlayerOptions,
  PlaybackMode,
  PlaybackRoute,
  ViewTarget,
  MediaConstraint,
  BroadcastStats,
  PlaybackStats,
  MebiusQuality,
  QualityChange,
  CaptionsOptions,
  CaptionSegment,
  MebiusErrorCode,
  ScreenWatchOptions,
  ScreenControlOptions,
  ScreenCredentials,
  ScreenCredentialStore,
  ScreenShareOptions,
  ScreenDeviceInfo,
  ScreenSessionInfo,
} from "./types.js";
