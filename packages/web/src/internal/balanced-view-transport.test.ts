import { describe, expect, it, vi } from "vitest";
import { syncLiveEdge, FlvViewTransport, DEFAULT_BALANCED_TARGET_S } from "./balanced-view-transport.js";
import type { SignalingClient } from "./signaling.js";

/** A video element with just the surface syncLiveEdge touches. */
function video(currentTime: number, bufferedEnd: number | null): HTMLVideoElement {
  return {
    currentTime,
    playbackRate: 1,
    buffered:
      bufferedEnd === null
        ? { length: 0, end: () => 0 }
        : { length: 1, end: () => bufferedEnd },
  } as unknown as HTMLVideoElement;
}

// The cushion of arrived-but-unshown video is what absorbs an unsteady network.
// The previous policy threw it away every time it recovered — and did so with a
// seek, which was a visible stutter of its own. These pin down that it is now
// held, and corrected by speed rather than by jumping.
describe("syncLiveEdge", () => {
  const T = DEFAULT_BALANCED_TARGET_S;

  it("leaves the picture alone when the cushion is about right", () => {
    const v = video(20 - T, 20);
    syncLiveEdge(v);
    expect(v.currentTime).toBe(20 - T);
    expect(v.playbackRate).toBe(1);
  });

  it("plays slightly fast when it has drifted behind, without jumping", () => {
    const before = 20 - T * 2;
    const v = video(before, 20);
    syncLiveEdge(v);
    expect(v.currentTime).toBe(before); // no seek — that was the old stutter
    expect(v.playbackRate).toBeGreaterThan(1);
    expect(v.playbackRate).toBeLessThanOrEqual(1.1); // above this the pitch is audible
  });

  it("plays slightly slow to rebuild a cushion that is too thin", () => {
    const v = video(19.9, 20); // hard against the live edge, nothing in reserve
    syncLiveEdge(v);
    expect(v.currentTime).toBe(19.9);
    expect(v.playbackRate).toBeLessThan(1);
    expect(v.playbackRate).toBeGreaterThanOrEqual(0.95);
  });

  it("jumps only when speed alone would take minutes to close the gap", () => {
    const v = video(0, 60);
    syncLiveEdge(v);
    expect(v.currentTime).toBeCloseTo(60 - T);
    expect(v.playbackRate).toBe(1);
  });

  it("honours an explicit target", () => {
    const v = video(15, 20); // 5s of cushion
    syncLiveEdge(v, 5);
    expect(v.playbackRate).toBe(1); // on target for this caller
    const tight = video(17, 20); // 3s of cushion
    syncLiveEdge(tight, 1); // far too much for this caller: catch up
    expect(tight.playbackRate).toBeGreaterThan(1);
  });

  it("does nothing with an empty buffer", () => {
    const v = video(0, null);
    syncLiveEdge(v);
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
