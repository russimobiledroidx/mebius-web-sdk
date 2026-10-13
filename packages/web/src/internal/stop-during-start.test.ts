import { describe, expect, it, vi } from "vitest";
import type { SignalingClient } from "./signaling.js";

/**
 * The ViewTransport contract: a stop() that lands while start() is still
 * pending leaves nothing attached. The player stops an opening route once and
 * never again — by then the element may belong to the app's next player — so a
 * route that attached after its stop would download for a viewer who left, into
 * a MediaSource the app had already cleared.
 */

const flvCreate = vi.fn();
vi.mock("flv.js", () => ({
  default: { isSupported: () => true, createPlayer: flvCreate, Events: { ERROR: "error" } },
}));
const hlsCtor = vi.fn();
vi.mock("hls.js", () => ({
  default: Object.assign(
    function Hls(...a: unknown[]) {
      hlsCtor(...a);
    },
    { isSupported: () => true, Events: {} },
  ),
}));

const { FlvViewTransport } = await import("./balanced-view-transport.js");
const { HlsViewTransport } = await import("./scale-view-transport.js");

const element = () =>
  ({
    addEventListener() {},
    removeEventListener() {},
    removeAttribute() {},
    load() {},
    canPlayType: () => "",
  }) as unknown as HTMLVideoElement;

const signaling = {
  deliveryUrl: (p: string) => `https://cdn.test${p}`,
  scalePlaylistUrl: () => "https://cdn.test/s.m3u8",
  accessToken: () => "t",
} as unknown as SignalingClient;

describe("stop() during start()", () => {
  it("FLV: stopped while flv.js loads, no player is created", async () => {
    const t = new FlvViewTransport(signaling, "/d/fast/s1");
    const starting = t.start("s1", element());
    await t.stop();
    await starting;
    expect(flvCreate).not.toHaveBeenCalled();
  });

  it("HLS: stopped while hls.js loads, no instance is created", async () => {
    const t = new HlsViewTransport(signaling, "/d/scale/s1.m3u8");
    const starting = t.start("s1", element());
    await t.stop();
    await starting;
    expect(hlsCtor).not.toHaveBeenCalled();
  });
});
