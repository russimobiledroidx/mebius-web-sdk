/**
 * Native bridge contract for @mebius/react-native.
 *
 * The JS layer in this package is a thin facade. All real work is delegated to
 * a native module (iOS/Android) that implements {@link MebiusNativeBridge}.
 * The native implementation is forthcoming; this interface is the agreed
 * contract it must satisfy. As with every Mebius surface, NO transport-protocol
 * terms appear here — the native side decides delivery internally.
 */
import type {
  BroadcasterOptions,
  MebiusInitOptions,
  PlaybackMode,
} from "./types.js";

/** Opaque handles minted by the native side. */
export type NativeHandle = string;

export interface MebiusNativeBridge {
  init(options: MebiusInitOptions): void;
  connect(token: string): Promise<NativeHandle>;
  disconnect(client: NativeHandle): void;

  createBroadcaster(client: NativeHandle, options: BroadcasterOptions): Promise<NativeHandle>;
  broadcasterStart(handle: NativeHandle, streamId: string): Promise<void>;
  broadcasterStop(handle: NativeHandle): Promise<void>;
  broadcasterSwitchCamera(handle: NativeHandle): Promise<void>;
  broadcasterSetMicEnabled(handle: NativeHandle, enabled: boolean): void;
  broadcasterSetCameraEnabled(handle: NativeHandle, enabled: boolean): void;

  createPlayer(client: NativeHandle, mode: PlaybackMode): Promise<NativeHandle>;
  playerPlay(handle: NativeHandle, streamId: string, viewTag: number): Promise<void>;
  playerStop(handle: NativeHandle): Promise<void>;
  playerSetVolume(handle: NativeHandle, volume: number): void;

  /** Subscribe to a native event channel; returns an unsubscribe fn. */
  addListener(handle: NativeHandle, event: string, cb: (payload: unknown) => void): () => void;
}

let registered: MebiusNativeBridge | null = null;

/**
 * Register the native bridge. The forthcoming native module calls this at load
 * time. Apps normally never call it directly.
 */
export function registerNativeBridge(bridge: MebiusNativeBridge): void {
  registered = bridge;
}

/** @internal Get the bridge or `null` if the native module isn't installed. */
export function getNativeBridge(): MebiusNativeBridge | null {
  return registered;
}
