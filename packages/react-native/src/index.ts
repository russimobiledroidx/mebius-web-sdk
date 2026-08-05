/**
 * @mebius-io/react-native.
 *
 * Exposes the canonical Mebius API surface. Calls are delegated to a native
 * bridge (see {@link MebiusNativeBridge}). A ready-made bridge backed by
 * `react-native-webrtc` ships in this package — register it once at startup
 * with `registerWebRTCBridge(RNWebRTC)`. If no bridge is registered, the facade
 * throws a clear `NOT_IMPLEMENTED` MebiusError rather than a silent no-op.
 */
import { getNativeBridge, type NativeHandle } from "./bridge.js";
import { SessionReporter, type TelemetryTarget } from "./telemetry.js";
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
export { registerWebRTCBridge, createWebRTCBridge } from "./webrtc-bridge.js";
export type { RNWebRTCModule } from "./rn-webrtc.js";

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
      "No Mebius native bridge is registered. Install react-native-webrtc and call " +
        "registerWebRTCBridge(RNWebRTC) at startup, or register a custom MebiusNativeBridge.",
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
    const handle = await bridgeOrThrow().connect(options.token, options.deliveries ?? []);
    const telemetry =
      options.beaconToken && options.beaconUrl
        ? { token: options.beaconToken, url: options.beaconUrl }
        : null;
    return new MebiusClient(handle, telemetry, options.userId);
  },
};

export class MebiusClient {
  /** @internal */
  constructor(
    private readonly handle: NativeHandle,
    private readonly telemetry: TelemetryTarget | null = null,
    private readonly userId?: string,
  ) {}

  async createBroadcaster(options: BroadcasterOptions = {}): Promise<MebiusBroadcaster> {
    const h = await bridgeOrThrow().createBroadcaster(this.handle, options);
    return new MebiusBroadcaster(h, this.telemetry, this.userId);
  }
  async createPlayer(options: PlayerOptions = {}): Promise<MebiusPlayer> {
    const h = await bridgeOrThrow().createPlayer(this.handle, options.mode ?? "auto");
    return new MebiusPlayer(h, this.telemetry, this.userId);
  }
  /**
   * A player for a stream you are interacting WITH (the other side of a
   * co-broadcast), where a second of delay makes the interaction feel broken.
   * Same API as a player; the delay budget is spent differently.
   */
  async createMonitor(): Promise<MebiusPlayer> {
    const h = await bridgeOrThrow().createPlayer(this.handle, "low-latency");
    return new MebiusPlayer(h, this.telemetry, this.userId);
  }
  disconnect(): void {
    bridgeOrThrow().disconnect(this.handle);
  }
}

export class MebiusBroadcaster {
  private reporter: SessionReporter | null = null;

  /** @internal */
  constructor(
    private readonly handle: NativeHandle,
    private readonly telemetry: TelemetryTarget | null = null,
    private readonly userId?: string,
  ) {}
  async start(streamId: string): Promise<void> {
    await bridgeOrThrow().broadcasterStart(this.handle, streamId);
    if (this.telemetry) {
      this.reporter = new SessionReporter(this.telemetry, "pub", streamId, this.userId);
      this.reporter.start();
    }
  }
  async stop(): Promise<void> {
    // Flush before the transport goes away: the span reported is the airtime.
    await this.reporter?.stop();
    this.reporter = null;
    await bridgeOrThrow().broadcasterStop(this.handle);
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
  private reporter: SessionReporter | null = null;

  /** @internal */
  constructor(
    private readonly handle: NativeHandle,
    private readonly telemetry: TelemetryTarget | null = null,
    private readonly userId?: string,
  ) {}
  /** `viewTag` is the native tag of the Mebius view component. */
  async play(streamId: string, viewTag: number): Promise<void> {
    await bridgeOrThrow().playerPlay(this.handle, streamId, viewTag);
    if (this.telemetry) {
      this.reporter = new SessionReporter(this.telemetry, "play", streamId, this.userId);
      this.reporter.start();
    }
  }
  async stop(): Promise<void> {
    await this.reporter?.stop();
    this.reporter = null;
    await bridgeOrThrow().playerStop(this.handle);
  }
  setVolume(volume: number): void {
    bridgeOrThrow().playerSetVolume(this.handle, Math.min(1, Math.max(0, volume)));
  }
}
