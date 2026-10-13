import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignalingClient } from "./internal/signaling.js";
import { MebiusPlayer } from "./player.js";
import type { ViewTransport } from "./internal/transport.js";
import type { PlaybackStats } from "./types.js";

/**
 * A route that dies mid-broadcast must not end the watch.
 *
 * Route selection used to run once, at play(). Whatever delivered the first
 * frame served the rest of the session, and when it later stopped — an edge
 * restarting, a publisher reconnecting, a second of lost network — the element
 * kept its last decoded frame and the SDK went quiet. A viewer calls that a
 * black screen, and on a broadcast that runs for a day it is not an edge case.
 *
 * These tests pin down that a lost route is reopened, that an endless stall
 * counts as lost, that the retrying is bounded, and that stopping the player
 * really stops it.
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

interface FakeRoute extends ViewTransport {
  /** Whether a start() actually produces a picture. Flip it to kill the route. */
  delivers: boolean;
  /** How many times the player has opened this route. */
  starts: number;
  /** True between a start() that delivered and the stop() that released it. */
  running: boolean;
  /** When set, start() waits on it — a route caught mid-open. */
  gate: Promise<void> | null;
  /** Drive the two signals a real transport raises. */
  fireEnded(): void;
  fireBuffering(): void;
}

function route(delivers = true): FakeRoute {
  let onEnded = () => {};
  let onBuffering = () => {};
  let stops = 0;
  const r: FakeRoute = {
    kind: "hls",
    delivers,
    starts: 0,
    running: false,
    gate: null,
    async start(_id: string, video: HTMLVideoElement) {
      r.starts += 1;
      const stopsAtStart = stops;
      if (r.gate) await r.gate;
      // The ViewTransport contract: a stop() during start() leaves nothing running.
      if (stops !== stopsAtStart) return;
      if (!r.delivers) throw new Error("route refused");
      r.running = true;
      // Advancing the picture is the only signal the player trusts.
      Object.defineProperty(video, "currentTime", { value: 1, configurable: true });
      Object.defineProperty(video, "paused", { value: false, configurable: true });
    },
    async stop() {
      stops += 1;
      r.running = false;
    },
    async getStats(): Promise<PlaybackStats | null> {
      return null;
    },
    onEnded(cb: () => void) {
      onEnded = cb;
    },
    onBuffering(cb: () => void) {
      onBuffering = cb;
    },
    fireEnded: () => onEnded(),
    fireBuffering: () => onBuffering(),
  };
  return r;
}

function playerWith(candidates: ViewTransport[]): MebiusPlayer {
  const p = new MebiusPlayer(new SignalingClient(GATEWAY, "tok"));
  (p as unknown as { candidates: ViewTransport[] }).candidates = candidates;
  return p;
}

const videoEl = () => new StubVideo() as unknown as HTMLVideoElement;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a route that stops delivering", () => {
  it("is reopened, so the viewer never has to reload the page", async () => {
    const r = route();
    const p = playerWith([r]);
    await p.play("s1", videoEl());
    expect(r.starts).toBe(1);

    r.fireEnded();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(r.starts).toBe(2);
  });

  it("falls to another route when the dead one stays dead", async () => {
    const dead = route();
    const spare = route();
    const p = playerWith([dead, spare]);
    await p.play("s1", videoEl());
    expect(dead.starts).toBe(1);
    expect(spare.starts).toBe(0);

    dead.delivers = false;
    dead.fireEnded();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(spare.starts).toBe(1);
  });

  it("reports buffering before the first backoff, not a frozen frame in silence", async () => {
    const r = route();
    const p = playerWith([r]);
    const seen: string[] = [];
    p.on("buffering", () => seen.push("buffering"));
    await p.play("s1", videoEl());

    r.fireEnded();
    expect(seen).toEqual(["buffering"]);
  });
});

describe("a stall that never clears", () => {
  it("counts as a lost route once it outlasts the stall budget", async () => {
    const r = route();
    const p = playerWith([r]);
    await p.play("s1", videoEl());

    r.fireBuffering();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(r.starts).toBe(1); // still inside the budget: a slow route is not a dead one

    await vi.advanceTimersByTimeAsync(3_000);
    expect(r.starts).toBe(2);
  });

  it("does not push its own deadline out as flv.js repeats `waiting`", async () => {
    const r = route();
    const p = playerWith([r]);
    await p.play("s1", videoEl());

    // One long freeze, reported over and over — which is what flv.js actually does.
    for (let i = 0; i < 10; i += 1) {
      r.fireBuffering();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // The countdown was armed by the FIRST `waiting` and has now expired; the
    // reopen itself still waits out its own backoff.
    await vi.advanceTimersByTimeAsync(1_500);

    expect(r.starts).toBe(2);
  });
});

describe("when nothing comes back", () => {
  it("gives up after a bounded number of attempts and says the session ended", async () => {
    const r = route();
    const p = playerWith([r]);
    const ended = vi.fn();
    p.on("ended", ended);
    await p.play("s1", videoEl());

    r.delivers = false;
    r.fireEnded();
    // 1s + 2s + 4s + 8s + 16s of backoff, plus the route walk between them.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(r.starts).toBe(6); // the original open, then five attempts
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("does not leave a route running when stop() lands mid-reopen", async () => {
    // The window this covers: stop() tears down what is attached, but a reopen
    // already in flight attaches AFTER that and was never released — a stopped
    // player that keeps playing, keeps reporting telemetry, and keeps the
    // element. Nothing downstream can see it; it just never goes away.
    const r = route();
    const p = playerWith([r]);
    await p.play("s1", videoEl());

    let openGate = () => {};
    r.gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    r.fireEnded();
    await vi.advanceTimersByTimeAsync(1_500); // through the backoff, into start()
    expect(r.starts).toBe(2);
    expect(r.running).toBe(false); // still inside the gated start

    await p.stop();
    openGate();
    await vi.advanceTimersByTimeAsync(100);

    expect(r.running).toBe(false);
  });

  it("stops retrying the moment the caller stops the player", async () => {
    const r = route();
    const p = playerWith([r]);
    await p.play("s1", videoEl());

    r.delivers = false;
    r.fireEnded();
    await vi.advanceTimersByTimeAsync(200); // inside the first backoff
    await p.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(r.starts).toBe(1);
  });
});

describe("a route that keeps flapping", () => {
  it("is recovered every time, because the budget counts CONSECUTIVE failures", async () => {
    // A broadcast that runs for a day loses its route more than five times. If
    // the budget were for the life of the player, the afternoon would be spent.
    const r = route();
    const p = playerWith([r]);
    const ended = vi.fn();
    p.on("ended", ended);
    await p.play("s1", videoEl());

    for (let i = 0; i < 8; i += 1) {
      r.fireEnded();
      await vi.advanceTimersByTimeAsync(1_500);
    }

    expect(r.starts).toBe(9); // the original open, then one per loss
    expect(ended).not.toHaveBeenCalled();
  });
});

describe("stop() while a route is still opening", () => {
  it("stops that route and opens no other, so nothing keeps downloading for a viewer who left", async () => {
    const opening = route();
    const next = route();
    let open: () => void = () => undefined;
    opening.gate = new Promise<void>((r) => (open = r));
    opening.delivers = false; // released after the stop: a refused start must not walk on
    const stop = vi.spyOn(opening, "stop");
    const p = playerWith([opening, next]);
    const playing = p.play("s1", videoEl());
    await vi.advanceTimersByTimeAsync(0);

    await p.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    open();
    await playing;
    expect(next.starts).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1); // not again: the element may belong to the next player
  });

  it("does not accept a route that delivers after the stop", async () => {
    const opening = route();
    let open: () => void = () => undefined;
    opening.gate = new Promise<void>((r) => (open = r));
    const p = playerWith([opening]);
    const seen: string[] = [];
    p.on("playing", () => seen.push("playing"));
    const playing = p.play("s1", videoEl());
    await vi.advanceTimersByTimeAsync(0);
    await p.stop();
    open();
    await playing;
    expect(seen).toEqual([]);
    expect((p as unknown as { transport: unknown }).transport).toBeNull();
  });
});

describe("stop() order", () => {
  it("tears the route down before the telemetry flush, which is a network request", async () => {
    const r = route();
    const order: string[] = [];
    r.stop = async () => void order.push("route");
    const p = playerWith([r]);
    await p.play("s1", videoEl());
    (p as unknown as { reporter: { stop(): Promise<void> } }).reporter = { stop: async () => void order.push("telemetry") };
    await p.stop();
    expect(order).toEqual(["route", "telemetry"]);
  });
});

describe("stop() around play(), audit follow-ups", () => {
  it("a stop while play() waits for the element's previous player opens nothing", async () => {
    const video = videoEl();
    const first = route();
    const p1 = playerWith([first]);
    await p1.play("s1", video);
    let release: () => void = () => undefined;
    first.stop = () => new Promise<void>((r) => (release = () => r()));
    const second = route();
    const p2 = playerWith([second]);
    const playing = p2.play("s1", video);
    await vi.advanceTimersByTimeAsync(0);
    await p2.stop();
    release();
    await playing;
    expect(second.starts).toBe(0);
  });

  it("play() right after a stop() during recovery plays, instead of being refused as still recovering", async () => {
    const r = route();
    const p = playerWith([r]);
    await p.play("s1", videoEl());
    r.fireEnded(); // recovery sleeps in its backoff
    await p.stop();
    await p.play("s1", videoEl());
    expect(r.starts).toBe(2);
  });

  it("play() settles as soon as stop() lands during the first-frame wait, not 8s later", async () => {
    const r = route();
    r.start = async () => {
      r.starts += 1; // opens, but no picture yet
    };
    const p = playerWith([r]);
    let settled = false;
    const playing = p.play("s1", videoEl()).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    await p.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(true);
    await playing;
  });
});
