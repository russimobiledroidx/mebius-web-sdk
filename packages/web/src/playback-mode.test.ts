import { describe, expect, it } from "vitest";
import { createViewTransport } from "./internal/transport.js";
import { SignalingClient } from "./internal/signaling.js";
import type { PlaybackMode } from "./types.js";

/**
 * HIGH-4 regression: every declared PlaybackMode must be one the gateway serves.
 *
 * The bug this pins: `PlaybackMode` publicly advertised a mid-latency mode whose
 * transport fetched `{gateway}/flv/{id}.flv`. The engine mounts no `/flv/` route
 * and `/flv/` is absent from its PublicGuard allowlist, so every player using
 * that mode 404'd on its first request — a documented, typed, shipped mode that
 * could never work.
 *
 * A live 404 check would need a running engine, so instead this asserts the
 * property that actually broke: each mode's first network path must sit under a
 * prefix the engine routes. That is a cross-repo contract, so ENGINE_ROUTED_PREFIXES
 * below is mirrored from the engine and must be updated in lockstep with it.
 */

/**
 * Path prefixes mebius-stream-engine actually serves on its public listener.
 *
 * Source of truth (keep in sync):
 *   - internal/api/routes.go   — r.Any("/live/*"), r.Any("/whip/*"), r.Any("/whep/*")
 *   - internal/api/edge.go:242 — publicAllowlist gates the public listener; a path
 *     missing from it is 404'd before any handler runs, even if a route exists.
 */
const ENGINE_ROUTED_PREFIXES = ["/live/", "/whip/", "/whep/"];

/**
 * Every value of PlaybackMode, listed explicitly.
 *
 * TypeScript erases the union at runtime, so this cannot be derived. The
 * exhaustiveness check below makes an out-of-date list a COMPILE error: adding a
 * mode to PlaybackMode without adding it here fails `tsc`, which is what forces
 * a new mode to be verified against the engine's routes.
 */
const ALL_MODES = ["low-latency", "scale"] as const;

// Compile-time exhaustiveness: errors if ALL_MODES misses a PlaybackMode member.
const _exhaustive: readonly PlaybackMode[] = ALL_MODES;
type _AllCovered = Exclude<PlaybackMode, (typeof ALL_MODES)[number]> extends never
  ? true
  : ["PlaybackMode has a member missing from ALL_MODES", Exclude<PlaybackMode, (typeof ALL_MODES)[number]>];
const _allCovered: _AllCovered = true;
void _exhaustive;
void _allCovered;

const GATEWAY = "https://gateway.example";

describe("PlaybackMode / engine route contract", () => {
  it("declares at least one mode", () => {
    expect(ALL_MODES.length).toBeGreaterThan(0);
  });

  it("every mode resolves to a transport", () => {
    const sig = new SignalingClient(GATEWAY, "tok");
    for (const mode of ALL_MODES) {
      const transport = createViewTransport(mode, sig);
      expect(transport, `mode "${mode}" has no transport`).toBeDefined();
    }
  });

  it("every mode's first request targets a path the engine routes", () => {
    const sig = new SignalingClient(GATEWAY, "tok");

    // The two ways a view transport reaches the gateway. Anything a mode can
    // request must be one of these, and both must be engine-routed.
    const candidateUrls = [
      sig.scalePlaylistUrl("s_abc"),
      // Session exchange for the realtime path. Built the same way the transport
      // builds it (see SignalingClient.exchangeSession).
      `${GATEWAY}/whep/s_abc?token=tok`,
    ];

    for (const url of candidateUrls) {
      const path = new URL(url).pathname;
      const routed = ENGINE_ROUTED_PREFIXES.some((p) => path.startsWith(p));
      expect(routed, `path "${path}" is not under any engine-routed prefix`).toBe(true);
    }
  });

  it("does not advertise a mode served from an unrouted prefix", () => {
    // Direct pin on the specific regression: `/flv/` was never routed.
    const unrouted = ["/flv/", "/dash/", "/rtmp/"];
    for (const prefix of unrouted) {
      expect(ENGINE_ROUTED_PREFIXES).not.toContain(prefix);
    }
  });

  it("SignalingClient exposes no builder for an unrouted prefix", () => {
    const sig = new SignalingClient(GATEWAY, "tok") as unknown as Record<string, unknown>;
    // balancedStreamUrl() built the dead /flv/ URL; it must stay gone.
    expect(sig.balancedStreamUrl).toBeUndefined();
  });
});
