/**
 * Standalone single-file build entry.
 *
 * Produces one self-contained browser file (everything bundled, including the
 * scale-mode playback engine) that exposes Mebius as plain globals — drop it in
 * with a <script> tag, no npm / no build step:
 *
 *   <script src="mebius.min.js"></script>
 *   <script>
 *     Mebius.init({ appId: "app_123", gateway: "https://gateway.mebius.io" });
 *     const client = Mebius.connect({ token });
 *   </script>
 */
import { Mebius } from "./mebius.js";
import { MebiusError, mebiusError } from "./errors.js";

const g = globalThis as unknown as Record<string, unknown>;
g.Mebius = Mebius;
g.MebiusError = MebiusError;
g.mebiusError = mebiusError;

export { Mebius, MebiusError, mebiusError };
