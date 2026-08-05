import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QoeReporter } from "./telemetry.js";

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

describe("QoeReporter", () => {
  it("sends nothing when there is nothing to report", async () => {
    const spy = fetchSpy();
    const r = new QoeReporter(target, "pub", "s1");
    r.start();
    await r.stop();
    expect(spy).not.toHaveBeenCalled();
  });

  it("batches samples and authenticates with the beacon credential", async () => {
    const spy = fetchSpy();
    const r = new QoeReporter(target, "pub", "s1", "u9");
    r.start();
    r.add({ ts: 100, bitrateKbps: 1200, fps: 30 });
    r.add({ ts: 102, bitrateKbps: 1100, fps: 30 });
    await r.stop();

    expect(spy).toHaveBeenCalledTimes(1);
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer beacon-jwt");
    const body = bodyOf(spy);
    expect(body).toMatchObject({ streamId: "s1", role: "pub", userId: "u9" });
    expect(body.samples).toHaveLength(2);
    // The tenant is never sent: it lives in the token's signed claims, and a body
    // that disagrees with them is rejected by the server.
    expect(JSON.stringify(body)).not.toContain("integratorId");
    expect(JSON.stringify(body)).not.toContain("websiteId");
    expect(typeof body.sessionId).toBe("string");
  });

  it("keeps one session id across batches, so watch time is not split", async () => {
    const spy = fetchSpy();
    const r = new QoeReporter(target, "play", "s1");
    r.start();
    r.add({ ts: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    r.add({ ts: 2 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(bodyOf(spy, 0).sessionId).toBe(bodyOf(spy, 1).sessionId);
  });

  it("flushes at the server's per-request cap instead of growing past it", async () => {
    const spy = fetchSpy();
    const r = new QoeReporter(target, "pub", "s1");
    r.start();
    for (let i = 0; i < 64; i++) r.add({ ts: i });
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bodyOf(spy).samples).toHaveLength(64);
  });

  it("swallows a failed send — telemetry must never break the stream", async () => {
    fetchSpy(false);
    const r = new QoeReporter(target, "pub", "s1");
    r.start();
    r.add({ ts: 1 });
    await expect(r.stop()).resolves.toBeUndefined();
  });

  it("swallows a rejected send too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    const r = new QoeReporter(target, "play", "s1");
    r.start();
    r.add({ ts: 1 });
    await expect(r.stop()).resolves.toBeUndefined();
  });

  it("uses sendBeacon with a query credential on the unload path", async () => {
    // sendBeacon cannot set headers, and losing the last batch of every session
    // that ends by closing the tab would lose that session's watch time.
    fetchSpy();
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon, platform: "TestOS" });
    const r = new QoeReporter(target, "play", "s1");
    r.add({ ts: 1 });
    await r.flush(true);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(String(sendBeacon.mock.calls[0][0])).toContain("token=beacon-jwt");
    expect(fetch).not.toHaveBeenCalled();
  });
});
