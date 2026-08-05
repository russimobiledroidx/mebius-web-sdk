import { describe, expect, it, vi } from "vitest";
import { SignalingClient } from "./internal/signaling.js";
import { createViewCandidates } from "./internal/transport.js";
import { MebiusPlayer } from "./player.js";
import type { ViewTransport } from "./internal/transport.js";
import type { PlaybackStats } from "./types.js";

const GATEWAY = "https://gateway.example";

// Minimal DOM stand-ins. These tests exercise route selection and the watchdog,
// neither of which needs a real DOM — a full jsdom environment would be slower and
// would still not decode video.
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
// Media Source presence is what gates the buffered route; default it to available
// so the ordering tests see the same candidate list a desktop browser would.
// @ts-expect-error — test double for a browser global
globalThis.MediaSource ??= class {};
const sig = () => new SignalingClient(GATEWAY, "tok");

describe("delivery path resolution", () => {
  it("resolves a gateway-relative path against the gateway and attaches the token", () => {
    const url = new URL(sig().deliveryUrl("/d/fast/s_abc"));
    expect(url.origin).toBe(GATEWAY);
    expect(url.pathname).toBe("/d/fast/s_abc");
    expect(url.searchParams.get("token")).toBe("tok");
  });

  it("refuses any path that could send the token to another host", () => {
    // The token is a bearer credential. A delivery path is data from a response,
    // so an absolute or protocol-relative one must never be fetched — that is how
    // a compromised or misconfigured gateway would exfiltrate viewer tokens.
    for (const hostile of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "http://evil.example/x",
      "d/fast/s_abc", // not rooted: would resolve against the current page
      "",
    ]) {
      expect(() => sig().deliveryUrl(hostile), `accepted ${hostile}`).toThrow();
    }
  });
});

describe("candidate ordering", () => {
  it("preserves the gateway's order and appends the origin fallback", () => {
    const c = createViewCandidates("auto", sig(), [
      { kind: "fast", path: "/d/fast/s1" },
      { kind: "wide", path: "/d/wide/s1" },
    ]);
    // 2 from the gateway + the origin playlist, which must always be last so a
    // route that costs us nothing is tried before one that costs us bandwidth.
    expect(c).toHaveLength(3);
  });

  it("skips an unknown kind rather than guessing at it", () => {
    const c = createViewCandidates("auto", sig(), [{ kind: "quantum", path: "/d/quantum/s1" }]);
    expect(c).toHaveLength(1); // origin fallback only
  });

  it("never offers the buffered route when the platform has no Media Source", () => {
    // iOS Safari. Handing it the buffered route would be a guaranteed black frame.
    const original = globalThis.MediaSource;
    // @ts-expect-error — simulating a platform without MSE
    delete globalThis.MediaSource;
    try {
      const c = createViewCandidates("balanced", sig(), [
        { kind: "fast", path: "/d/fast/s1" },
        { kind: "wide", path: "/d/wide/s1" },
      ]);
      expect(c).toHaveLength(2); // wide + origin; fast dropped
    } finally {
      if (original) globalThis.MediaSource = original;
    }
  });

  it("still produces a playable candidate with no deliveries at all", () => {
    // Every 0.x integration passes no deliveries. They must keep working.
    expect(createViewCandidates("scale", sig())).toHaveLength(1);
  });
});

/** A transport that reports success but optionally never renders anything. */
function fakeTransport(opts: { delivers: boolean; fails?: boolean }) {
  const t: ViewTransport & { started: boolean; stopped: boolean } = {
    started: false,
    stopped: false,
    async start(_id: string, video: HTMLVideoElement) {
      t.started = true;
      if (opts.fails) throw new Error("open failed");
      if (opts.delivers) {
        // Advance the picture, which is the only signal the player trusts.
        Object.defineProperty(video, "currentTime", { value: 1, configurable: true });
        Object.defineProperty(video, "paused", { value: false, configurable: true });
      }
    },
    async stop() {
      t.stopped = true;
    },
    async getStats(): Promise<PlaybackStats | null> {
      return null;
    },
    onEnded() {},
    onBuffering() {},
  };
  return t;
}

function playerWith(candidates: ViewTransport[]): MebiusPlayer {
  const p = new MebiusPlayer(sig());
  // The candidate list is built in the constructor from mode + deliveries; swap it
  // to drive the fallback walk directly rather than standing up real transports.
  (p as unknown as { candidates: ViewTransport[] }).candidates = candidates;
  return p;
}

function videoEl(): HTMLVideoElement {
  return new StubVideo() as unknown as HTMLVideoElement;
}

describe("first-frame watchdog", () => {
  it("moves to the next route when one opens but delivers no frames", async () => {
    vi.useFakeTimers();
    try {
      const dead = fakeTransport({ delivers: false });
      const live = fakeTransport({ delivers: true });
      const p = playerWith([dead, live]);

      const playing = p.play("s1", videoEl());
      // This is the bug the watchdog exists for: the dead route resolved start()
      // successfully. Without the timeout, playback would sit here forever showing
      // a black frame and never reach `live`.
      await vi.advanceTimersByTimeAsync(8000);
      await playing;

      expect(dead.started).toBe(true);
      expect(dead.stopped).toBe(true); // torn down before the next route opened
      expect(live.started).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts the first route immediately when it does deliver", async () => {
    const live = fakeTransport({ delivers: true });
    const unused = fakeTransport({ delivers: true });
    const p = playerWith([live, unused]);

    await p.play("s1", videoEl());

    expect(live.started).toBe(true);
    expect(unused.started).toBe(false); // no needless second connection
  });

  it("keeps walking past a route that throws", async () => {
    const broken = fakeTransport({ delivers: false, fails: true });
    const live = fakeTransport({ delivers: true });
    const p = playerWith([broken, live]);

    await p.play("s1", videoEl());

    expect(live.started).toBe(true);
  });

  it("reports failure rather than pretending to play when nothing delivers", async () => {
    vi.useFakeTimers();
    try {
      const p = playerWith([fakeTransport({ delivers: false })]);
      const playing = p.play("s1", videoEl()).then(
        () => "resolved",
        () => "rejected",
      );
      await vi.advanceTimersByTimeAsync(8000);
      expect(await playing).toBe("rejected");
    } finally {
      vi.useRealTimers();
    }
  });
});
