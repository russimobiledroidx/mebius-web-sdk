import { describe, expect, it } from "vitest";
import { chaseLiveEdge } from "./balanced-view-transport.js";

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
