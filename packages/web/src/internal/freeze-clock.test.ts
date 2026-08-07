import { describe, expect, it } from "vitest";
import { FreezeClock } from "./freeze-clock.js";

/** Controllable clock, so the arithmetic is tested rather than the wall clock. */
function at(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("FreezeClock", () => {
  it("reports nothing when playback never stalled", () => {
    const c = new FreezeClock(at().now);
    expect(c.take()).toBe(0);
    expect(c.stalled).toBe(false);
  });

  it("regression: a completed stall is measured, not reported as zero", () => {
    // The bug this exists for: freeze ratio read 0.00% on every session because
    // nothing ever subtracted resume-time from stall-time.
    const t = at();
    const c = new FreezeClock(t.now);
    c.beginStall();
    t.advance(1500);
    c.endStall();
    expect(c.take()).toBe(1500);
  });

  it("repeated buffering events during one stall do not restart the clock", () => {
    // flv.js fires `waiting` repeatedly through a single stall.
    const t = at();
    const c = new FreezeClock(t.now);
    c.beginStall();
    t.advance(1000);
    c.beginStall();
    t.advance(1000);
    c.beginStall();
    t.advance(1000);
    c.endStall();
    expect(c.take()).toBe(3000);
  });

  it("an in-progress stall is reported as it happens, then continues", () => {
    const t = at();
    const c = new FreezeClock(t.now);
    c.beginStall();
    t.advance(2000);
    expect(c.take()).toBe(2000);
    t.advance(2000);
    expect(c.take()).toBe(2000); // not 4000 — the first 2s were already reported
    expect(c.stalled).toBe(true);
  });

  it("every millisecond is attributed exactly once across a stall that spans ticks", () => {
    const t = at();
    const c = new FreezeClock(t.now);
    c.beginStall();
    t.advance(500);
    const a = c.take();
    t.advance(500);
    c.endStall();
    const b = c.take();
    expect(a + b).toBe(1000);
  });

  it("taking twice does not double-count a finished stall", () => {
    const t = at();
    const c = new FreezeClock(t.now);
    c.beginStall();
    t.advance(800);
    c.endStall();
    expect(c.take()).toBe(800);
    expect(c.take()).toBe(0);
  });

  it("endStall without a stall in progress is a no-op", () => {
    const c = new FreezeClock(at().now);
    c.endStall();
    expect(c.take()).toBe(0);
  });

  it("reset forgets a stall in progress", () => {
    const t = at();
    const c = new FreezeClock(t.now);
    c.beginStall();
    t.advance(5000);
    c.reset();
    expect(c.stalled).toBe(false);
    expect(c.take()).toBe(0);
  });

  it("accumulates several separate stalls", () => {
    const t = at();
    const c = new FreezeClock(t.now);
    c.beginStall(); t.advance(300); c.endStall();
    t.advance(10_000); // healthy playback in between
    c.beginStall(); t.advance(700); c.endStall();
    expect(c.take()).toBe(1000);
  });
});
