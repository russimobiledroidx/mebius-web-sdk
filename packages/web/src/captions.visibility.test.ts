import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MebiusCaptions } from "./captions.js";
import type { SignalingClient } from "./internal/signaling.js";
import type { MebiusPlayer } from "./player.js";

/**
 * A caption session bills per second of broadcast audio, and the engine only
 * stops one once nobody is subscribed. A tab left open in the background holds
 * that subscriber open while showing the viewer nothing — the difference
 * between roughly two and a half minutes of billing and the four-hour session
 * cap.
 *
 * The suite runs in vitest's `node` environment, so `document` is stubbed here
 * rather than pulling in jsdom: the code under test touches exactly four
 * members of it, and a DOM implementation is a large dependency to add for
 * three tests.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

const listeners = new Set<() => void>();
let visibility: "hidden" | "visible" = "visible";

const fakeDocument = {
  get visibilityState() {
    return visibility;
  },
  addEventListener(type: string, cb: () => void) {
    if (type === "visibilitychange") listeners.add(cb);
  },
  removeEventListener(type: string, cb: () => void) {
    if (type === "visibilitychange") listeners.delete(cb);
  },
};

function setVisibility(state: "hidden" | "visible") {
  visibility = state;
  for (const cb of [...listeners]) cb();
}

const signaling = () => ({ captionsUrl: () => "https://engine/captions" }) as unknown as SignalingClient;
const player = () => ({ currentEpochMs: () => 1000 }) as unknown as MebiusPlayer;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("document", fakeDocument);
  FakeEventSource.instances.length = 0;
  listeners.clear();
  visibility = "visible";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MebiusCaptions hidden-tab suspend", () => {
  it("drops the feed after the page stays hidden, and restores it on return", () => {
    const c = new MebiusCaptions(signaling(), player(), { lang: "id" });
    c.start("st_1");
    expect(FakeEventSource.instances).toHaveLength(1);

    setVisibility("hidden");
    vi.advanceTimersByTime(30_000);
    expect(FakeEventSource.instances[0]!.closed).toBe(false); // still within grace

    vi.advanceTimersByTime(40_000); // past the grace window
    expect(FakeEventSource.instances[0]!.closed).toBe(true);

    setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
    c.stop();
  });

  it("keeps the feed through a brief tab switch", () => {
    const c = new MebiusCaptions(signaling(), player(), { lang: "id" });
    c.start("st_1");

    setVisibility("hidden");
    vi.advanceTimersByTime(5_000);
    setVisibility("visible");
    vi.advanceTimersByTime(120_000);

    // Same connection throughout: a five-second glance at another tab must not
    // churn the subscriber, and must not leave a timer armed that closes the
    // feed a minute after the viewer came back.
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.closed).toBe(false);
    c.stop();
  });

  it("stops listening for visibility once torn down", () => {
    const c = new MebiusCaptions(signaling(), player(), { lang: "id" });
    c.start("st_1");
    c.stop();

    setVisibility("visible");
    // A feed reopened after stop() is a subscriber nobody asked for, billing
    // against a component that is already gone.
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
