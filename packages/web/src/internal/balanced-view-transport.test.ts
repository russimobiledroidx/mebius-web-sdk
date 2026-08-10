import { describe, expect, it, vi } from "vitest";
import { chaseLiveEdge, FlvViewTransport } from "./balanced-view-transport.js";
import type { SignalingClient } from "./signaling.js";

/** A video element with just the surface chaseLiveEdge touches. */
function video(currentTime: number, bufferedEnd: number | null): HTMLVideoElement {
  return {
    currentTime,
    buffered:
      bufferedEnd === null
        ? { length: 0, end: () => 0 }
        : { length: 1, end: () => bufferedEnd },
  } as unknown as HTMLVideoElement;
}

describe("chaseLiveEdge", () => {
  it("skips forward when playback has drifted behind the live edge", () => {
    const v = video(10, 20);
    chaseLiveEdge(v);
    // Near the edge, but not on it: landing exactly on the edge starves instantly.
    expect(v.currentTime).toBeCloseTo(19.6);
  });

  it("leaves a small gap alone — the skip would be worse than the delay", () => {
    const v = video(19, 20);
    chaseLiveEdge(v);
    expect(v.currentTime).toBe(19);
  });

  it("does nothing with an empty buffer", () => {
    const v = video(0, null);
    chaseLiveEdge(v);
    expect(v.currentTime).toBe(0);
  });
});

// Regression: without this, captions never render at all on the FLV route —
// MebiusCaptions withholds every segment until the playhead reaches its
// epochMs, and a transport returning null here means that comparison never
// runs. HLS has EXT-X-PROGRAM-DATE-TIME to read; FLV has no such signal, so
// this is necessarily an estimate, not a measurement.
describe("FlvViewTransport.playheadEpochMs", () => {
  it("estimates behind the wall clock rather than returning null", () => {
    const t = new FlvViewTransport({} as SignalingClient, "/d/fast/s1");
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const estimate = t.playheadEpochMs();
    expect(estimate).not.toBeNull();
    // Behind, never ahead — per the caption design's hard rule (docs/
    // INTEGRATION.md §6.3): a caption showing early is a spoiler, showing
    // late is invisible.
    expect(estimate).toBeLessThan(now);
    vi.restoreAllMocks();
  });

  // The buffered-but-unshown media is the one part of FLV's delay that IS
  // measurable. Reading it keeps a viewer with a shallow buffer from waiting
  // out someone else's worst case: every millisecond of over-estimate is a
  // caption withheld for no reason, on top of the STT latency already paid.
  it("counts buffered-ahead media, so a shallow buffer waits less", () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const withBuffer = (aheadSeconds: number) => {
      const t = new FlvViewTransport({} as SignalingClient, "/d/fast/s1");
      (t as unknown as { video: unknown }).video = {
        currentTime: 10,
        buffered: { length: 1, end: () => 10 + aheadSeconds },
      };
      return t.playheadEpochMs()!;
    };

    const shallow = withBuffer(0.2);
    const deep = withBuffer(4);
    expect(shallow).toBeGreaterThan(deep);
    // ~3.8s of extra buffer must show up as ~3.8s further behind, not as a
    // constant the buffer never affects.
    expect(shallow - deep).toBeCloseTo(3800, -2);
    vi.restoreAllMocks();
  });
});
