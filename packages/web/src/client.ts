import { MebiusBroadcaster } from "./broadcaster.js";
import { mebiusError } from "./errors.js";
import { TypedEmitter, type ClientEventMap } from "./events.js";
import { MebiusPlayer } from "./player.js";
import { SignalingClient } from "./internal/signaling.js";
import type { TelemetryTarget } from "./internal/telemetry.js";
import { readToken } from "./internal/token.js";
import type {
  BroadcasterOptions,
  MebiusDelivery,
  MebiusInitOptions,
  PlayerOptions,
} from "./types.js";

/**
 * A live connection to Mebius. Obtain one from {@link Mebius.connect}, then
 * create broadcasters and players from it.
 */
export class MebiusClient extends TypedEmitter<ClientEventMap> {
  private readonly signaling: SignalingClient;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  /** @internal */
  constructor(
    config: MebiusInitOptions,
    private readonly token: string,
    private readonly deliveries: readonly MebiusDelivery[] = [],
    private readonly telemetry: TelemetryTarget | null = null,
    private readonly userId?: string,
  ) {
    super();
    this.signaling = new SignalingClient(config.gateway, token);
  }

  /** @internal Called by {@link Mebius.connect}. */
  open(): void {
    const { expiresAtMs } = readToken(this.token);
    const now = Date.now();
    if (expiresAtMs !== null && expiresAtMs <= now) {
      // Surface asynchronously so listeners attached after connect() still fire.
      queueMicrotask(() => this.emit("error", mebiusError("TOKEN_EXPIRED")));
      return;
    }
    this.connected = true;
    if (expiresAtMs !== null) {
      this.expiryTimer = setTimeout(
        () => this.emit("error", mebiusError("TOKEN_EXPIRED")),
        Math.max(0, expiresAtMs - now),
      );
    }
    queueMicrotask(() => this.emit("connected", undefined));
  }

  /** Create a broadcaster bound to this connection. */
  createBroadcaster(options: BroadcasterOptions = {}): MebiusBroadcaster {
    this.assertConnected();
    return new MebiusBroadcaster(this.signaling, options, this.telemetry, this.userId);
  }

  /** Create a player bound to this connection. */
  createPlayer(options: PlayerOptions = {}): MebiusPlayer {
    this.assertConnected();
    return new MebiusPlayer(this.signaling, options, this.deliveries, this.telemetry, this.userId);
  }

  /**
   * Create a monitor: a player tuned for watching a stream you are interacting
   * WITH rather than merely watching — the other side of a co-broadcast, where a
   * second or two of delay makes the interaction feel broken.
   *
   * It is a player with the delay budget spent differently, not a different API:
   * it starts on the real-time route and falls back on its own if that route
   * delivers no frames. Apps used to hand-roll this (open a real-time view, run a
   * timer, swap players when it stayed black); getting the fallback wrong showed a
   * black frame to a live audience, so it belongs here rather than in every app.
   */
  createMonitor(): MebiusPlayer {
    this.assertConnected();
    return new MebiusPlayer(this.signaling, { mode: "low-latency" }, this.deliveries, this.telemetry, this.userId);
  }

  /** Close the connection and release resources. */
  disconnect(reason?: string): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.connected = false;
    this.emit("disconnected", { reason });
    this.removeAllListeners();
  }

  private assertConnected(): void {
    if (!this.connected) throw mebiusError("NOT_CONNECTED");
  }
}
