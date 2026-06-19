import { MebiusClient } from "./client.js";
import { mebiusError } from "./errors.js";
import type { MebiusConnectOptions, MebiusInitOptions } from "./types.js";

let config: MebiusInitOptions | null = null;

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
    const client = new MebiusClient(config, options.token);
    client.open();
    return client;
  },

  /** @internal Reset configuration (used in tests). */
  _reset(): void {
    config = null;
  },
};
