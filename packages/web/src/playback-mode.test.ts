import { describe, expect, it } from "vitest";
import { createViewCandidates, createViewTransport } from "./internal/transport.js";
import { SignalingClient } from "./internal/signaling.js";
import type { PlaybackMode } from "./types.js";

/**
 * HIGH-4 regression: every declared PlaybackMode must be one the gateway serves.
 *
 * The original bug: `PlaybackMode` advertised a mid-latency mode whose transport
 * fetched `{gateway}/flv/{id}.flv`, a path the engine neither routed nor
 * allowlisted — a documented, typed, shipped mode that could never work.
 *
 * What changed since: the engine now serves that delivery, under a neutral path
 * (`/d/{kind}/{streamId}`) rather than a protocol-named one, and the SDK no
 * longer hardcodes the path at all — it uses the gateway's own `deliveries`
 * list. The property under test is unchanged: nothing a mode can request may sit
 * outside a prefix the engine routes.
 *
 * ENGINE_ROUTED_PREFIXES is a cross-repo contract, mirrored from the engine and
 * updated in lockstep with it.
 */

/**
 * Path prefixes mebius-stream-engine actually serves on its public listener.
 *
 * Source of truth (keep in sync):
 *   - internal/api/routes.go — r.Any("/live/*"), "/whip/*", "/whep/*", and
 *     "/d/{kind}/*" for each CDN-backed delivery kind
 *   - internal/api/edge.go   — publicAllowlist gates the public listener; a path
 *     missing from it is 404'd before any handler runs, even if a route exists.
 */
const ENGINE_ROUTED_PREFIXES = ["/live/", "/whip/", "/whep/", "/d/"];

/**
 * Every value of PlaybackMode, listed explicitly.
 *
 * TypeScript erases the union at runtime, so this cannot be derived. NOTE: the
 * compile-time exhaustiveness pair below only bites when tests are type-checked;
 * `packages/web/tsconfig.json` excludes `**\/*.test.ts`, so treat the runtime
 * assertions in this file as the real guard.
 */
const ALL_MODES = ["auto", "low-latency", "balanced", "scale"] as const;

const _exhaustive: readonly PlaybackMode[] = ALL_MODES;
type _AllCovered = Exclude<PlaybackMode, (typeof ALL_MODES)[number]> extends never
  ? true
  : ["PlaybackMode has a member missing from ALL_MODES", Exclude<PlaybackMode, (typeof ALL_MODES)[number]>];
const _allCovered: _AllCovered = true;
void _exhaustive;
void _allCovered;

const GATEWAY = "https://gateway.example";

/** The delivery list a gateway with a CDN configured returns today. */
const DELIVERIES = [
  { kind: "fast", path: "/d/fast/s_abc" },
  { kind: "wide", path: "/d/wide/s_abc" },
  { kind: "local", path: "/live/s_abc/index.m3u8" },
];

describe("PlaybackMode / engine route contract", () => {
  it("declares at least one mode", () => {
    expect(ALL_MODES.length).toBeGreaterThan(0);
  });

  it("every mode resolves to at least one transport, with and without deliveries", () => {
    const sig = new SignalingClient(GATEWAY, "tok");
    for (const mode of ALL_MODES) {
      expect(createViewCandidates(mode, sig).length, `mode "${mode}" bare`).toBeGreaterThan(0);
      expect(
        createViewCandidates(mode, sig, DELIVERIES).length,
        `mode "${mode}" with deliveries`,
      ).toBeGreaterThan(0);
      expect(createViewTransport(mode, sig), `mode "${mode}" legacy`).toBeDefined();
    }
  });

  it("every URL a mode can request targets a path the engine routes", () => {
    const sig = new SignalingClient(GATEWAY, "tok");

    const candidateUrls = [
      sig.scalePlaylistUrl("s_abc"),
      // Session exchange for the realtime path, built as exchangeSession builds it.
      `${GATEWAY}/whep/s_abc?token=tok`,
      // Every gateway-supplied delivery, resolved the way a transport resolves it.
      ...DELIVERIES.map((d) => sig.deliveryUrl(d.path)),
    ];

    for (const url of candidateUrls) {
      const path = new URL(url).pathname;
      const routed = ENGINE_ROUTED_PREFIXES.some((p) => path.startsWith(p));
      expect(routed, `path "${path}" is not under any engine-routed prefix`).toBe(true);
    }
  });

  it("does not advertise a mode served from an unrouted prefix", () => {
    for (const prefix of ["/flv/", "/hls/", "/dash/", "/rtmp/"]) {
      expect(ENGINE_ROUTED_PREFIXES).not.toContain(prefix);
    }
  });

  it("SignalingClient exposes no builder for an unrouted prefix", () => {
    const sig = new SignalingClient(GATEWAY, "tok") as unknown as Record<string, unknown>;
    // balancedStreamUrl() built the dead /flv/ URL; it must stay gone. The path
    // now comes from the gateway, so the SDK has no business inventing one.
    expect(sig.balancedStreamUrl).toBeUndefined();
  });
});
