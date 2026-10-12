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
// 0.9.1 ran it at 0.1-0.8s and CDN jitter froze the picture three times a
// minute while the speed hunted 0.98<->1.1. These pin down the smooth policy:
// a ~1.8s cushion, corrections within 5% of normal speed, hysteresis between
// starting and stopping one, and no more than one speed change per 3s.
describe("syncLiveEdge", () => {
  const T = DEFAULT_BALANCED_TARGET_S;
  const at = (drift: number, rate = 1) => {
    const v = video(100 - drift, 100);
    v.playbackRate = rate;
    return v;
  };

  it("targets a cushion of 1.5-2s by default", () => {
    expect(T).toBeGreaterThanOrEqual(1.5);
    expect(T).toBeLessThanOrEqual(2);
  });

  it.each([
    // drift, expected rate, seeks?
    [1.8, 1, false], // steady state: leave it alone
    [1, 1, false], // thin but normal jitter: never slow above 0.5s
    [3.4, 1, false], // somewhat behind, not yet worth correcting
    [4, 1.05, false], // gentle catch-up, inaudible
    [7.9, 1.05, false],
    [10, 1, true], // past ~8s: jump back to target
    [0.3, 0.95, false], // nearly empty: rebuild the cushion slowly
  ])("drift %ss → rate %s, seek %s", (drift, rate, seeks) => {
    const v = at(drift);
    expect(syncLiveEdge(v, T, 0)).toBe(seeks);
    expect(v.playbackRate).toBe(rate);
    expect(v.currentTime).toBeCloseTo(seeks ? 100 - T : 100 - drift);
  });

  it("keeps catching up until back near the target, not just under the start threshold", () => {
    const v = at(3, 1.05);
    syncLiveEdge(v, T, 10_000);
    expect(v.playbackRate).toBe(1.05); // 3s: still above target + 0.4
    const back = at(2.1, 1.05);
    syncLiveEdge(back, T, 10_000);
    expect(back.playbackRate).toBe(1);
  });

  it("keeps rebuilding until the cushion is back to 1s", () => {
    const v = at(0.8, 0.95);
    syncLiveEdge(v, T, 10_000);
    expect(v.playbackRate).toBe(0.95);
    const rebuilt = at(1.1, 0.95);
    syncLiveEdge(rebuilt, T, 10_000);
    expect(rebuilt.playbackRate).toBe(1);
  });

  it("changes speed at most once per 3s on one element", () => {
    const v = at(4);
    syncLiveEdge(v, T, 0);
    expect(v.playbackRate).toBe(1.05);
    v.currentTime = 100 - 0.3; // buffer collapsed right after
    syncLiveEdge(v, T, 1000);
    expect(v.playbackRate).toBe(1.05); // held
    syncLiveEdge(v, T, 3000);
    expect(v.playbackRate).toBe(0.95);
  });

  it("does not oscillate across a jittery sequence", () => {
    // 60s of timeupdates (4/s) with the cushion wandering 0.6-3.4s, the way an
    // edge's jitter moves it: every reading is inside the leave-alone band.
    const v = video(0, 0);
    let edge = 100;
    let rateChanges = 0;
    for (let i = 0; i < 240; i++) {
      const drift = 2 + 1.4 * Math.sin(i * 0.7) * Math.cos(i * 0.13);
      edge += 0.25;
      v.currentTime = edge - drift;
      (v as unknown as { buffered: unknown }).buffered = { length: 1, end: () => edge };
      const before = v.playbackRate;
      syncLiveEdge(v, T, i * 250);
      if (v.playbackRate !== before) rateChanges++;
    }
    expect(rateChanges).toBe(0);

    // Now a buffer that keeps crossing the catch-up and slow thresholds: the
    // hold bounds the changes to one per 3s, and hysteresis keeps it well below.
    const w = video(0, 0);
    const rates: number[] = [];
    for (let i = 0; i < 240; i++) {
      const drift = i % 8 < 4 ? 0.4 : 4.2; // flips every second
      edge += 0.25;
      w.currentTime = edge - drift;
      (w as unknown as { buffered: unknown }).buffered = { length: 1, end: () => edge };
      const before = w.playbackRate;
      syncLiveEdge(w, T, 100_000 + i * 250);
      if (w.playbackRate !== before) rates.push(i * 250);
    }
    for (let k = 1; k < rates.length; k++) {
      expect(rates[k]! - rates[k - 1]!).toBeGreaterThanOrEqual(3000);
    }
    expect(rates.length).toBeGreaterThan(0);
    expect(rates.length).toBeLessThanOrEqual(20);
  });

  it("honours an explicit target", () => {
    const v = video(95, 100); // 5s of cushion
    syncLiveEdge(v, 5, 0);
    expect(v.playbackRate).toBe(1); // on target for this caller
    const tight = video(97, 100); // 3s of cushion
    syncLiveEdge(tight, 1, 0); // well past 1 + 1.7 for this caller: catch up
    expect(tight.playbackRate).toBe(1.05);
  });

  it("scales the slow band down for a very low target instead of playing slow forever", () => {
    const v = video(99.6, 100); // 0.4s of cushion, on target for 0.4
    syncLiveEdge(v, 0.4, 0);
    expect(v.playbackRate).toBe(1);
  });

  it("does nothing with an empty buffer", () => {
    const v = video(0, null);
    expect(syncLiveEdge(v)).toBe(false);
    expect(v.currentTime).toBe(0);
    expect(v.playbackRate).toBe(1);
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
