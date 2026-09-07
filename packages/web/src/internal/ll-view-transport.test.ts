import { describe, expect, it } from "vitest";
import { holdBuffer, WhepViewTransport, DEFAULT_REALTIME_TARGET_MS } from "./ll-view-transport.js";
import type { SignalingClient } from "./signaling.js";

/**
 * The real-time route's whole smoothness story is this one call: hold a little
 * video back so a re-sent piece still arrives in time to be used.
 */
describe("holdBuffer", () => {
  it("sets both the current and the legacy property, in their own units", () => {
    const r = { jitterBufferTarget: null, playoutDelayHint: null } as unknown as RTCRtpReceiver;
    holdBuffer(r, 1500);
    const seen = r as unknown as { jitterBufferTarget: number; playoutDelayHint: number };
    expect(seen.jitterBufferTarget).toBe(1500); // milliseconds
    expect(seen.playoutDelayHint).toBe(1.5); // seconds
  });

  it("leaves a browser that supports neither alone instead of throwing", () => {
    expect(() => holdBuffer({} as RTCRtpReceiver, 300)).not.toThrow();
  });

  it("keeps conversation usable by default", () => {
    // Low enough that talking back still feels immediate, high enough that a
    // single re-sent packet no longer costs a multi-second freeze.
    expect(DEFAULT_REALTIME_TARGET_MS).toBeGreaterThan(0);
    expect(DEFAULT_REALTIME_TARGET_MS).toBeLessThanOrEqual(500);
  });
});

type Stat = Record<string, unknown>;

function transportReporting(...reports: Stat[][]): WhepViewTransport {
  const t = new WhepViewTransport({} as SignalingClient);
  let call = 0;
  (t as unknown as { pc: unknown }).pc = {
    getStats: async () => new Map((reports[call++] ?? []).map((s, i) => [String(i), s])),
  };
  return t;
}

function inbound(over: Stat): Stat {
  return {
    type: "inbound-rtp",
    kind: "video",
    framesPerSecond: 30,
    packetsLost: 0,
    packetsReceived: 0,
    bytesReceived: 0,
    totalFreezesDuration: 0,
    jitterBufferDelay: 0,
    jitterBufferEmittedCount: 0,
    ...over,
  };
}

const pair: Stat = { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.04 };

// A frozen real-time picture reports a healthy connection and raises no event
// on the video element. If this route does not measure its own freezes, nothing
// does — and the dashboard shows a flawless session over a still frame.
describe("WhepViewTransport.getStats", () => {
  it("reports freeze time the video element cannot see", async () => {
    const t = transportReporting(
      [inbound({}), pair],
      [inbound({ totalFreezesDuration: 2.5 }), pair],
    );
    await t.getStats();
    const stats = await t.getStats();
    expect(stats?.freezeMs).toBe(2500);
  });

  it("claims nothing on the first reading, having nothing to compare against", async () => {
    const t = transportReporting([inbound({ totalFreezesDuration: 9 }), pair]);
    const stats = await t.getStats();
    expect(stats?.freezeMs).toBeUndefined();
    expect(stats?.bitrateKbps).toBeUndefined();
    // What IS measurable from one reading is still reported.
    expect(stats?.framesPerSecond).toBe(30);
    expect(stats?.rttMs).toBe(40);
  });

  it("reports loss over the window, not over the whole session", async () => {
    const t = transportReporting(
      [inbound({ packetsLost: 100, packetsReceived: 9900 }), pair],
      [inbound({ packetsLost: 105, packetsReceived: 9995 }), pair],
    );
    await t.getStats();
    const stats = await t.getStats();
    // 5 lost out of 100 in this window — not 105/10100 for the session so far.
    expect(stats?.packetLossPct).toBeCloseTo(5, 1);
  });

  it("reports the delay actually being lived with, plus the network leg", async () => {
    const t = transportReporting(
      [inbound({ jitterBufferDelay: 0, jitterBufferEmittedCount: 0 }), pair],
      [inbound({ jitterBufferDelay: 6, jitterBufferEmittedCount: 20 }), pair],
    );
    await t.getStats();
    const stats = await t.getStats();
    // 6s across 20 frames = 300ms held, + half of a 40ms round trip.
    expect(stats?.latencyMs).toBe(320);
  });

  it("ignores audio, so the picture's loss figure is not diluted", async () => {
    const audio: Stat = { type: "inbound-rtp", kind: "audio", packetsLost: 999, packetsReceived: 1 };
    const t = transportReporting(
      [inbound({ packetsLost: 0, packetsReceived: 1000 }), audio, pair],
      [inbound({ packetsLost: 0, packetsReceived: 2000 }), audio, pair],
    );
    await t.getStats();
    const stats = await t.getStats();
    expect(stats?.packetLossPct).toBe(0);
  });
});
