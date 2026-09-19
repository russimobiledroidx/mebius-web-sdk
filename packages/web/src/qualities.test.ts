import { describe, expect, it, vi } from "vitest";
import { SignalingClient } from "./internal/signaling.js";
import { MebiusPlayer } from "./player.js";
import type { ViewTransport } from "./internal/transport.js";
import type { MebiusQuality, PlaybackStats } from "./types.js";

/**
 * CR-2: an honest answer about renditions.
 *
 * Mebius publishes one rendition and transcodes no ladder, so the only correct
 * answer today is "there is nothing to choose". These tests pin that answer down
 * so a UI can hide its quality menu on the data instead of on a hunch — and pin
 * down that asking for a rendition that does not exist fails loudly without
 * taking playback with it.
 */

const GATEWAY = "https://gateway.example";

class StubVideo {
  volume = 1;
  currentTime = 0;
  paused = true;
  src = "";
  srcObject: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  removeAttribute(): void {}
  load(): void {}
  canPlayType(): string {
    return "";
  }
  play(): Promise<void> {
    return Promise.resolve();
  }
}
// @ts-expect-error — test double for a browser global
globalThis.HTMLVideoElement = StubVideo;
// @ts-expect-error — test double for a browser global
globalThis.MediaSource ??= class {};

const sig = () => new SignalingClient(GATEWAY, "tok");

/** A transport that reports success but optionally never renders anything. */
function fakeTransport(opts: { delivers: boolean }): ViewTransport {
  return {
    kind: "hls",
    async start(_id: string, video: HTMLVideoElement) {
      if (opts.delivers) {
        // Advance the picture, which is the only signal the player trusts.
        Object.defineProperty(video, "currentTime", { value: 1, configurable: true });
        Object.defineProperty(video, "paused", { value: false, configurable: true });
      }
    },
    async stop() {},
    async getStats(): Promise<PlaybackStats | null> {
      return null;
    },
    onEnded() {},
    onBuffering() {},
  };
}

function playerWith(candidates: ViewTransport[]): MebiusPlayer {
  const p = new MebiusPlayer(sig());
  // The candidate list is built in the constructor; swap it to drive the route
  // walk directly rather than standing up real transports.
  (p as unknown as { candidates: ViewTransport[] }).candidates = candidates;
  return p;
}

const videoEl = () => new StubVideo() as unknown as HTMLVideoElement;

describe("MebiusPlayer.qualities", () => {
  it("is empty before playback, so a UI can decide without waiting", () => {
    expect(playerWith([]).qualities).toEqual([]);
  });

  it("is empty on a single-rendition stream, which is every Mebius stream today", async () => {
    const p = playerWith([fakeTransport({ delivers: true })]);
    await p.play("s1", videoEl());
    expect(p.qualities).toEqual([]);
  });

  it("announces the list once when a route is accepted", async () => {
    const seen: (readonly MebiusQuality[])[] = [];
    // One dead route then a live one: the player walks past the first, so exactly
    // one route is ever accepted and exactly one announcement is due.
    const p = playerWith([fakeTransport({ delivers: false }), fakeTransport({ delivers: true })]);
    p.on("qualities-changed", (q) => seen.push(q));

    vi.useFakeTimers();
    try {
      const playing = p.play("s1", videoEl());
      await vi.advanceTimersByTimeAsync(8000);
      await playing;
    } finally {
      vi.useRealTimers();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([]);
  });

  it("survives a listener that throws, without killing the stream", async () => {
    // The realistic first integrator bug: a menu handler written against a
    // ladder does `q[0].label` and throws on the empty list. The announcement
    // happens on the route-acceptance path, so an exception escaping it used to
    // be caught as a ROUTE failure — tearing down a stream that had already
    // delivered its first frame, and reporting it as a connection error.
    const p = playerWith([fakeTransport({ delivers: true })]);
    p.on("qualities-changed", (q) => {
      throw new Error(`no such rendition: ${(q as MebiusQuality[])[0]!.label}`);
    });

    await expect(p.play("s1", videoEl())).resolves.toBeUndefined();
    expect((p as unknown as { playing: boolean }).playing).toBe(true);
    expect((p as unknown as { transport: unknown }).transport).not.toBeNull();
  });

  it("never announces a route that failed to deliver", async () => {
    const seen: unknown[] = [];
    const p = playerWith([fakeTransport({ delivers: false })]);
    p.on("qualities-changed", (q) => seen.push(q));

    vi.useFakeTimers();
    try {
      const playing = p.play("s1", videoEl()).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(8000);
      await playing;
    } finally {
      vi.useRealTimers();
    }

    expect(seen).toHaveLength(0);
  });
});

describe("MebiusPlayer.setQuality", () => {
  it('accepts "auto", the default', async () => {
    const p = playerWith([fakeTransport({ delivers: true })]);
    await p.play("s1", videoEl());
    await expect(p.setQuality("auto")).resolves.toBeUndefined();
  });

  it("rejects an id that is not on offer, and leaves playback alone", async () => {
    const p = playerWith([fakeTransport({ delivers: true })]);
    await p.play("s1", videoEl());

    await expect(p.setQuality("ngawur")).rejects.toThrow(/ngawur/);
    // Still playing: a refused request must not be a way to kill a stream.
    expect((p as unknown as { playing: boolean }).playing).toBe(true);
    expect((p as unknown as { transport: unknown }).transport).not.toBeNull();
  });

  it("rejects before playback too, rather than pretending to queue a choice", async () => {
    await expect(playerWith([]).setQuality("720p")).rejects.toThrow();
  });
});
