import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SessionReporter } from "./telemetry.js";

const target = { url: "https://api.example/api/ingest/beacon", token: "beacon-jwt" };

function fetchSpy(ok = true) {
  const spy = vi.fn(async () => ({ ok, status: ok ? 200 : 500 }) as Response);
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}

function bodyOf(spy: ReturnType<typeof fetchSpy>, call = 0): Record<string, unknown> {
  const init = spy.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}"));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SessionReporter", () => {
  it("reports a session that ends inside the first interval", async () => {
    // Viewer minutes come from the reported span, so a short session that never
    // reached a heartbeat must still produce one.
    const spy = fetchSpy();
    const r = new SessionReporter(target, "play", "s1");
    r.start();
    await r.stop();
    expect(spy).toHaveBeenCalledTimes(1);
    const body = bodyOf(spy);
    expect(body).toMatchObject({ streamId: "s1", role: "play" });
    expect((body.samples as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("authenticates with the beacon credential and never sends tenant ids", async () => {
    const spy = fetchSpy();
    const r = new SessionReporter(target, "pub", "s1", "u9");
    r.start();
    await r.stop();
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer beacon-jwt");
    const body = bodyOf(spy);
    expect(body.userId).toBe("u9");
    expect(JSON.stringify(body)).not.toContain("websiteId");
  });

  it("keeps one session id, so a long watch is not split into many sessions", async () => {
    const spy = fetchSpy();
    const r = new SessionReporter(target, "play", "s1");
    r.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await r.stop();
    const ids = new Set(spy.mock.calls.map((_, i) => bodyOf(spy, i).sessionId));
    expect(ids.size).toBe(1);
  });

  it("carries only timestamps — no invented quality metrics", async () => {
    // This platform has no stats surface; reporting a made-up bitrate would put
    // fiction into a dashboard people bill from.
    const spy = fetchSpy();
    const r = new SessionReporter(target, "play", "s1");
    r.start();
    await r.stop();
    for (const s of bodyOf(spy).samples as Record<string, unknown>[]) {
      expect(Object.keys(s)).toEqual(["ts"]);
    }
  });

  it("swallows a failed or rejected send", async () => {
    fetchSpy(false);
    const a = new SessionReporter(target, "play", "s1");
    a.start();
    await expect(a.stop()).resolves.toBeUndefined();

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    const b = new SessionReporter(target, "pub", "s2");
    b.start();
    await expect(b.stop()).resolves.toBeUndefined();
  });

  it("stops beating after stop()", async () => {
    const spy = fetchSpy();
    const r = new SessionReporter(target, "play", "s1");
    r.start();
    await r.stop();
    const after = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy.mock.calls.length).toBe(after);
  });
});
