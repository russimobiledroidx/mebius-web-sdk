import { MebiusClient } from "./client.js";
import { mebiusError } from "./errors.js";
import { MebiusScreenShare } from "./screen-share.js";
import { MebiusScreenViewer } from "./screen-viewer.js";
import type { MebiusConnectOptions, MebiusInitOptions, ScreenShareOptions } from "./types.js";

let config: MebiusInitOptions | null = null;

function requireConfig(): MebiusInitOptions {
  if (!config) throw mebiusError("UNKNOWN", "Call Mebius.init() first.");
  return config;
}

/**
 * Entry point to the Mebius Web SDK.
 *
 * ```ts
 * Mebius.init({ appId: "app_123", gateway: "https://gateway.mebius.io" });
 * const client = Mebius.connect({ token });
 * ```
 */
export const Mebius = {
  /** Configure the SDK once, before connecting. */
  init(options: MebiusInitOptions): void {
    if (!options.appId) throw mebiusError("UNKNOWN", "Mebius.init requires an appId.");
    if (!options.gateway) throw mebiusError("UNKNOWN", "Mebius.init requires a gateway URL.");
    config = { ...options };
  },

  /**
   * Connect using a short-lived token minted by your backend. Returns a
   * {@link MebiusClient}. Listen for `"connected"` / `"error"` on it.
   */
  connect(options: MebiusConnectOptions): MebiusClient {
    if (!config) {
      throw mebiusError("UNKNOWN", "Call Mebius.init() before Mebius.connect().");
    }
    if (!options.token) throw mebiusError("UNKNOWN", "Mebius.connect requires a token.");
    const telemetry =
      options.beaconToken && options.beaconUrl
        ? { token: options.beaconToken, url: options.beaconUrl }
        : null;
    const client = new MebiusClient(
      config,
      options.token,
      options.deliveries ?? [],
      telemetry,
      options.userId,
      options.getToken,
    );
    client.open();
    return client;
  },

  /**
   * Create a viewer for a screen session. Needs only {@link Mebius.init}: the
   * session's own view token, not a {@link Mebius.connect} token, is what
   * authorizes it.
   */
  createScreenViewer(): MebiusScreenViewer {
    return new MebiusScreenViewer(requireConfig().gateway);
  },

  /**
   * Share this browser's screen as an enrolled device. Needs only
   * {@link Mebius.init}; the device's own credentials authorize it.
   */
  createScreenShare(options: ScreenShareOptions = {}): MebiusScreenShare {
    return new MebiusScreenShare(requireConfig().gateway, options);
  },

  /** @internal Reset configuration (used in tests). */
  _reset(): void {
    config = null;
  },
};
