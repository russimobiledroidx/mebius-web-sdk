import { MebiusBroadcaster } from "./broadcaster.js";
import { MebiusCaptions } from "./captions.js";
import { mebiusError } from "./errors.js";
import { TypedEmitter, type ClientEventMap } from "./events.js";
import { MebiusPlayer } from "./player.js";
import { SignalingClient } from "./internal/signaling.js";
import type { TelemetryTarget } from "./internal/telemetry.js";
import { readToken } from "./internal/token.js";
import type {
  BroadcasterOptions,
  CaptionsOptions,
  MebiusDelivery,
  MebiusInitOptions,
  PlayerOptions,
} from "./types.js";

/**
 * Refresh this far ahead of expiry. Wide enough that a slow backend, a retry or
 * two, and a sleeping tab's throttled timer all still land before the old token
 * dies; the old one keeps working the whole time, so being early costs nothing.
 */
const REFRESH_MARGIN_MS = 60_000;
/** First retry delay after a failed refresh; doubles up to the cap. */
const REFRESH_RETRY_BASE_MS = 2_000;
const REFRESH_RETRY_MAX_MS = 30_000;

/**
 * A live connection to Mebius. Obtain one from {@link Mebius.connect}, then
 * create broadcasters and players from it.
 */
export class MebiusClient extends TypedEmitter<ClientEventMap> {
  private readonly signaling: SignalingClient;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private refreshFailures = 0;

  /** @internal */
  constructor(
    config: MebiusInitOptions,
    private token: string,
    private readonly deliveries: readonly MebiusDelivery[] = [],
    private readonly telemetry: TelemetryTarget | null = null,
    private readonly userId?: string,
    private readonly getToken?: () => string | Promise<string>,
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
    this.scheduleTokenWork(expiresAtMs);
    queueMicrotask(() => this.emit("connected", undefined));
  }

  /**
   * Arm whatever has to happen as this token approaches its expiry: renew it if
   * the app gave us a way to, otherwise report that the session is over.
   *
   * Renewing is what makes an unattended session possible at all. The gateway
   * checks the token on every media request, so without a fresh one playback
   * stops the moment it expires — no matter how healthy the stream is.
   */
  private scheduleTokenWork(expiresAtMs: number | null): void {
    this.clearTimer();
    if (expiresAtMs === null) return; // No expiry to act on.
    const remaining = expiresAtMs - Date.now();
    if (!this.getToken) {
      this.expiryTimer = setTimeout(
        () => this.emit("error", mebiusError("TOKEN_EXPIRED")),
        Math.max(0, remaining),
      );
      return;
    }
    this.expiryTimer = setTimeout(
      () => void this.refreshToken(expiresAtMs),
      Math.max(0, remaining - REFRESH_MARGIN_MS),
    );
  }

  private async refreshToken(previousExpiryMs: number): Promise<void> {
    if (!this.connected || !this.getToken) return;
    let next: string;
    try {
      next = await this.getToken();
    } catch (cause) {
      this.onRefreshFailed(previousExpiryMs, cause);
      return;
    }
    if (!this.connected) return; // Disconnected while awaiting.

    const { expiresAtMs } = readToken(next);
    if (expiresAtMs !== null && expiresAtMs <= previousExpiryMs) {
      // A provider handing back the same token (a cached response, a backend
      // that re-serves one credential) would put us in a hot refresh loop that
      // still ends in expiry. Say so once instead of spinning until the tab dies.
      this.emit(
        "error",
        mebiusError("TOKEN_EXPIRED", "Mebius token refresh returned a token that is not newer."),
      );
      return;
    }

    this.refreshFailures = 0;
    this.token = next;
    this.signaling.setToken(next);
    this.emit("token-refreshed", undefined);
    this.scheduleTokenWork(expiresAtMs);
  }

  /**
   * A failed refresh is not a dead session: the current token is still valid
   * until `expiryMs`, and the viewer is still watching. Retry inside that window
   * and only report expiry once it has actually run out.
   */
  private onRefreshFailed(expiryMs: number, cause: unknown): void {
    const remaining = expiryMs - Date.now();
    if (remaining <= 0) {
      this.emit("error", mebiusError("TOKEN_EXPIRED", undefined, cause));
      return;
    }
    this.refreshFailures += 1;
    const backoff = Math.min(
      REFRESH_RETRY_MAX_MS,
      REFRESH_RETRY_BASE_MS * 2 ** (this.refreshFailures - 1),
    );
    this.clearTimer();
    this.expiryTimer = setTimeout(
      () => void this.refreshToken(expiryMs),
      Math.min(backoff, remaining),
    );
  }

  private clearTimer(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
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

  /**
   * Subscribe to a stream's realtime captions.
   *
   * Reads the same feed a session already produces — it does NOT start the
   * caption session itself. `captions/start` spends money and requires an API
   * key, so it belongs to your own backend (see
   * mebius-stream-engine/docs/API.md §5.1), called once when you want captions
   * on for a stream. This only ever consumes what that call turned on.
   *
   * `player` must be the one showing `streamId`: captions are timed against its
   * playhead, and a mismatched player would compare against the wrong clock.
   */
  createCaptions(player: MebiusPlayer, options: CaptionsOptions): MebiusCaptions {
    this.assertConnected();
    return new MebiusCaptions(this.signaling, player, options);
  }

  /** Close the connection and release resources. */
  disconnect(reason?: string): void {
    this.clearTimer();
    this.connected = false;
    this.emit("disconnected", { reason });
    this.removeAllListeners();
  }

  private assertConnected(): void {
    if (!this.connected) throw mebiusError("NOT_CONNECTED");
  }
}
