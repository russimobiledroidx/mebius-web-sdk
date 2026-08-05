import { describe, expect, it, vi } from "vitest";
import { playWithAutoplayFallback, resetVideoElement } from "./autoplay.js";

/** Minimal stand-in for the bits of HTMLVideoElement these helpers touch. */
function fakeVideo(play: () => Promise<void>) {
  return {
    muted: false,
    playsInline: false,
    srcObject: {} as unknown,
    play: vi.fn(play),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  } as unknown as HTMLVideoElement & { play: ReturnType<typeof vi.fn> };
}

function notAllowed(): Error {
  const e = new Error("play() failed because the user didn't interact first");
  e.name = "NotAllowedError";
  return e;
}

describe("playWithAutoplayFallback", () => {
  it("plays with sound when the browser allows it", async () => {
    const v = fakeVideo(async () => undefined);
    expect(await playWithAutoplayFallback(v)).toEqual({ mutedByPolicy: false });
    expect(v.muted).toBe(false);
    expect(v.playsInline).toBe(true); // iOS refuses inline playback without it
  });

  it("mutes and retries when the autoplay policy refuses sound", async () => {
    // The bug this fixes: the rejection was swallowed, the element stayed on
    // frame zero, and a healthy stream looked dead.
    let calls = 0;
    const v = fakeVideo(async () => {
      if (++calls === 1) throw notAllowed();
    });
    expect(await playWithAutoplayFallback(v)).toEqual({ mutedByPolicy: true });
    expect(v.muted).toBe(true);
    expect(v.play).toHaveBeenCalledTimes(2);
  });

  it("rethrows a real failure instead of hiding it", async () => {
    // A decode/source error must reach the player, which is what drives the
    // fallback to the next route.
    const v = fakeVideo(async () => {
      throw new Error("no decoder");
    });
    await expect(playWithAutoplayFallback(v)).rejects.toThrow("no decoder");
  });

  it("does not loop when the element was already muted and still refused", async () => {
    const v = fakeVideo(async () => {
      throw notAllowed();
    });
    v.muted = true;
    await expect(playWithAutoplayFallback(v)).rejects.toThrow(/didn't interact/);
    expect(v.play).toHaveBeenCalledTimes(1);
  });
});

describe("resetVideoElement", () => {
  it("clears srcObject as well as src", () => {
    // While srcObject is set the element ignores src, so a failed real-time route
    // would otherwise keep every later route from rendering.
    const v = fakeVideo(async () => undefined);
    resetVideoElement(v);
    expect(v.srcObject).toBeNull();
    expect(v.removeAttribute).toHaveBeenCalledWith("src");
    expect(v.load).toHaveBeenCalled();
  });
});
