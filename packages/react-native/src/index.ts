/**
 * @mebius/react-native — skeleton.
 *
 * Exposes the canonical Mebius API surface. Calls are delegated to a native
 * bridge (see {@link MebiusNativeBridge}). Until the native module ships, the
 * facade throws a clear `NOT_IMPLEMENTED` MebiusError so integrators get an
 * unambiguous signal rather than a silent no-op.
 */
import { getNativeBridge, type NativeHandle } from "./bridge.js";
import type {
  BroadcasterOptions,
  MebiusConnectOptions,
  MebiusErrorCode,
  MebiusInitOptions,
  PlayerOptions,
} from "./types.js";

export * from "./types.js";
export {
  registerNativeBridge,
  type MebiusNativeBridge,
  type NativeHandle,
} from "./bridge.js";

export class MebiusError extends Error {
  readonly code: MebiusErrorCode;
  constructor(code: MebiusErrorCode, message: string) {
    super(message);
    this.name = "MebiusError";
    this.code = code;
  }
}

function bridgeOrThrow() {
  const b = getNativeBridge();
  if (!b) {
    throw new MebiusError(
      "NOT_IMPLEMENTED",
      "The Mebius native module is not installed yet. This is a skeleton package; " +
        "install/link the native bridge to enable broadcasting and playback.",
    );
  }
  return b;
}

let config: MebiusInitOptions | null = null;

export const Mebius = {
  init(options: MebiusInitOptions): void {
    config = { ...options };
    getNativeBridge()?.init(options);
  },
  async connect(options: MebiusConnectOptions): Promise<MebiusClient> {
    if (!config) throw new MebiusError("UNKNOWN", "Call Mebius.init() before connect().");
    const handle = await bridgeOrThrow().connect(options.token);
    return new MebiusClient(handle);
  },
};

export class MebiusClient {
  /** @internal */
  constructor(private readonly handle: NativeHandle) {}

  async createBroadcaster(options: BroadcasterOptions = {}): Promise<MebiusBroadcaster> {
    const h = await bridgeOrThrow().createBroadcaster(this.handle, options);
    return new MebiusBroadcaster(h);
  }
  async createPlayer(options: PlayerOptions): Promise<MebiusPlayer> {
    const h = await bridgeOrThrow().createPlayer(this.handle, options.mode);
    return new MebiusPlayer(h);
  }
  disconnect(): void {
    bridgeOrThrow().disconnect(this.handle);
  }
}

export class MebiusBroadcaster {
  /** @internal */
  constructor(private readonly handle: NativeHandle) {}
  start(streamId: string): Promise<void> {
    return bridgeOrThrow().broadcasterStart(this.handle, streamId);
  }
  stop(): Promise<void> {
    return bridgeOrThrow().broadcasterStop(this.handle);
  }
  switchCamera(): Promise<void> {
    return bridgeOrThrow().broadcasterSwitchCamera(this.handle);
  }
  setMicEnabled(enabled: boolean): void {
    bridgeOrThrow().broadcasterSetMicEnabled(this.handle, enabled);
  }
  setCameraEnabled(enabled: boolean): void {
    bridgeOrThrow().broadcasterSetCameraEnabled(this.handle, enabled);
  }
}

export class MebiusPlayer {
  /** @internal */
  constructor(private readonly handle: NativeHandle) {}
  /** `viewTag` is the native tag of the Mebius view component. */
  play(streamId: string, viewTag: number): Promise<void> {
    return bridgeOrThrow().playerPlay(this.handle, streamId, viewTag);
  }
  stop(): Promise<void> {
    return bridgeOrThrow().playerStop(this.handle);
  }
  setVolume(volume: number): void {
    bridgeOrThrow().playerSetVolume(this.handle, Math.min(1, Math.max(0, volume)));
  }
}
