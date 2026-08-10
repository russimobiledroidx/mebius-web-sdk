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

  it("drops a segment once it falls more than 5s behind the playhead, and emits cleared", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const player = fakePlayer(1000);
    const c = new MebiusCaptions(fakeSignaling(), player, { lang: "id" });
    const onSegment = vi.fn();
    const onCleared = vi.fn();
    c.on("segment", onSegment);
    c.on("cleared", onCleared);
    c.start("st_1");

    // interim, so it stays pending after being shown once
    FakeEventSource.instances[0]!.emit(caption({ state: "interim" }));
    vi.advanceTimersByTime(100);
    expect(onSegment).toHaveBeenCalledTimes(1);

    (player as unknown as { currentEpochMs: () => number }).currentEpochMs = () => 7000; // +6s
    vi.advanceTimersByTime(100);
    expect(onCleared).toHaveBeenCalledWith({ segmentId: "s1" });
  });

  it("stop() closes the connection and clears buffered state", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const c = new MebiusCaptions(fakeSignaling(), fakePlayer(0), { lang: "id" });
    c.start("st_1");
    c.stop();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });
});
