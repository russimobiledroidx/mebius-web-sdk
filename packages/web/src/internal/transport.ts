/**
 * INTERNAL — transport interfaces + auto-selection.
 *
 * The public API never names a transport; it only asks for a playback *mode*.
 * This factory maps a mode to the right hidden delivery mechanism.
 */
import type { BroadcastStats, PlaybackMode, PlaybackStats } from "../types.js";
import type { SignalingClient } from "./signaling.js";
import { WhipPublishTransport } from "./publish-transport.js";
import { WhepViewTransport } from "./ll-view-transport.js";
import { FlvViewTransport } from "./balanced-view-transport.js";
import { HlsViewTransport } from "./scale-view-transport.js";

/** Hidden transport that sends a captured stream to the gateway. */
export interface PublishTransport {
  start(streamId: string, stream: MediaStream): Promise<void>;
  stop(): Promise<void>;
  getStats(): Promise<BroadcastStats | null>;
  /** Swap the outgoing video track in place (e.g. on camera switch). */
  replaceVideoTrack(track: MediaStreamTrack | null): Promise<void>;
}

/** Hidden transport that renders a remote stream into a video element. */
export interface ViewTransport {
  start(streamId: string, video: HTMLVideoElement): Promise<void>;
  stop(): Promise<void>;
  getStats(): Promise<PlaybackStats | null>;
  /** Fired by the transport when playback reaches its natural end. */
  onEnded(cb: () => void): void;
  /** Fired when the transport (re)enters a buffering state. */
  onBuffering(cb: () => void): void;
}

export function createPublishTransport(signaling: SignalingClient): PublishTransport {
  return new WhipPublishTransport(signaling);
}

/** Auto-select the view transport for a playback mode. */
export function createViewTransport(
  mode: PlaybackMode,
  signaling: SignalingClient,
): ViewTransport {
  switch (mode) {
    case "low-latency":
      return new WhepViewTransport(signaling);
    case "balanced":
      return new FlvViewTransport(signaling);
    case "scale":
      return new HlsViewTransport(signaling);
  }
}
