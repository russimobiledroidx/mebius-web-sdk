import { afterEach, describe, expect, it, vi } from "vitest";
import { MebiusCaptions } from "./captions.js";
import type { SignalingClient } from "./internal/signaling.js";
import type { MebiusPlayer } from "./player.js";

/** Minimal EventSource stand-in: node has no native one, and this is all captions.ts uses. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  close(): void {
    this.closed = true;
  }
}

function fakeSignaling(): SignalingClient {
  return { captionsUrl: () => "wss://engine/captions" } as unknown as SignalingClient;
}

function fakePlayer(epochMs: number | null): MebiusPlayer {
  return { currentEpochMs: () => epochMs } as unknown as MebiusPlayer;
}

const caption = (over: Record<string, unknown> = {}) => ({
  type: "caption",
  segmentId: "s1",
  rev: 0,
  state: "final",
  epochMs: 1000,
  durationMs: 500,
  text: "hello",
  translations: { id: "halo" },
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances.length = 0;
  vi.useRealTimers();
});

describe("MebiusCaptions", () => {
  it("emits a segment once the playhead reaches its epochMs", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const player = fakePlayer(999); // before the segment is due
    const c = new MebiusCaptions(fakeSignaling(), player, { lang: "id" });
    const onSegment = vi.fn();
    c.on("segment", onSegment);
    c.start("st_1");

    FakeEventSource.instances[0]!.emit(caption());
    vi.advanceTimersByTime(100);
    expect(onSegment).not.toHaveBeenCalled();

    (player as unknown as { currentEpochMs: () => number }).currentEpochMs = () => 1000;
    vi.advanceTimersByTime(100);
    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment.mock.calls[0]![0]).toMatchObject({
      segmentId: "s1",
      text: "hello",
      translation: "halo",
      machineGenerated: true,
    });
  });

  it("keeps only the highest revision of a segment", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const c = new MebiusCaptions(fakeSignaling(), fakePlayer(1000), { lang: "id" });
    const onSegment = vi.fn();
    c.on("segment", onSegment);
    c.start("st_1");

    const es = FakeEventSource.instances[0]!;
    es.emit(caption({ rev: 0, state: "interim", text: "thanks for the" }));
    es.emit(caption({ rev: 2, state: "final", text: "thanks for the gift" }));
    es.emit(caption({ rev: 1, state: "interim", text: "STALE — must be dropped" }));
    vi.advanceTimersByTime(100);

    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment.mock.calls[0]![0].text).toBe("thanks for the gift");
  });

  // Staleness is measured from ARRIVAL, not from epoch-vs-playhead: the
  // playhead can be an estimate (FlvViewTransport), and measuring against a
  // guess silently deleted freshly-arrived captions whenever the guess ran
  // ahead of reality.
  it("clears a shown segment once it has been on screen longer than the window", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const c = new MebiusCaptions(fakeSignaling(), fakePlayer(1000), { lang: "id" });
    const onSegment = vi.fn();
    const onCleared = vi.fn();
    c.on("segment", onSegment);
    c.on("cleared", onCleared);
    c.start("st_1");

    FakeEventSource.instances[0]!.emit(caption());
    vi.advanceTimersByTime(100);
    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onCleared).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6000); // past the 5s on-screen window
    expect(onCleared).toHaveBeenCalledWith({ segmentId: "s1" });
  });

  // Regression: `if (now == null) return` meant a transport with no playhead
  // (WHEP, or HLS before its first PROGRAM-DATE-TIME) rendered NOTHING, ever —
  // a silently dead feature rather than a slightly mistimed one.
  it("renders on arrival when the transport has no playhead at all", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const c = new MebiusCaptions(fakeSignaling(), fakePlayer(null), { lang: "id" });
    const onSegment = vi.fn();
    c.on("segment", onSegment);
    c.start("st_1");

    FakeEventSource.instances[0]!.emit(caption());
    vi.advanceTimersByTime(100);
    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment.mock.calls[0]![0].translation).toBe("halo");
  });

  // Regression: a playhead that never reaches a segment's epochMs (a broken or
  // badly-estimated clock) used to queue that segment forever. Bounded wait,
  // then show it — a wrong clock must not become permanent silence.
  it("releases a segment whose playhead never catches up, after a bounded wait", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    // Playhead frozen far in the past: `due <= now` is never true.
    const c = new MebiusCaptions(fakeSignaling(), fakePlayer(0), { lang: "id" });
    const onSegment = vi.fn();
    c.on("segment", onSegment);
    c.start("st_1");

    FakeEventSource.instances[0]!.emit(caption({ epochMs: 999_999 }));
    vi.advanceTimersByTime(100);
    expect(onSegment).not.toHaveBeenCalled(); // still waiting for sync

    vi.advanceTimersByTime(2000); // past the bounded wait
    expect(onSegment).toHaveBeenCalledTimes(1);
  });

  it("stop() closes the connection and clears buffered state", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const c = new MebiusCaptions(fakeSignaling(), fakePlayer(0), { lang: "id" });
    c.start("st_1");
    c.stop();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });
});

// With interim revisions on, a segment stays pending while it is corrected.
// A plain "already shown this id" check re-emitted the same unchanged text on
// every 100ms tick — 10 renders a second of identical words.
describe("MebiusCaptions interim revisions", () => {
  it("emits once per revision, not once per tick", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const c = new MebiusCaptions(fakeSignaling(), fakePlayer(9_999_999), { lang: "id" });
    const onSegment = vi.fn();
    c.on("segment", onSegment);
    c.start("st_1");

    const es = FakeEventSource.instances[0]!;
    es.emit(caption({ rev: 0, state: "interim", text: "thanks" }));
    vi.advanceTimersByTime(500); // five ticks, one revision
    expect(onSegment).toHaveBeenCalledTimes(1);

    es.emit(caption({ rev: 1, state: "interim", text: "thanks for" }));
    vi.advanceTimersByTime(500);
    expect(onSegment).toHaveBeenCalledTimes(2);
    expect(onSegment.mock.calls[1]![0].text).toBe("thanks for");
  });
});
