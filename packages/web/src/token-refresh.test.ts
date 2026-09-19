import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Mebius } from "./mebius.js";
import { SignalingClient } from "./internal/signaling.js";
import { withCurrentToken } from "./internal/scale-view-transport.js";

/** Unsigned JWT-shaped token expiring `inSeconds` from now. */
function tokenExpiringIn(inSeconds: number, tag = "t"): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + inSeconds, tag }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}

const HOUR_S = 3600;

describe("session token refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Mebius._reset();
    Mebius.init({ appId: "app_1", gateway: "https://gateway.example" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Without a provider the old contract stands: the session ends with its token.
  it("reports expiry when the app gave no way to renew", async () => {
    const client = Mebius.connect({ token: tokenExpiringIn(HOUR_S) });
    const errors: string[] = [];
    client.on("error", (e) => errors.push(e.code));

    await vi.advanceTimersByTimeAsync(HOUR_S * 1000 + 1000);
    expect(errors).toEqual(["TOKEN_EXPIRED"]);
  });

  // The point of the whole feature: a session outliving its own credential.
  it("renews ahead of expiry and keeps going, with no error", async () => {
    let minted = 0;
    const client = Mebius.connect({
      token: tokenExpiringIn(HOUR_S),
      getToken: () => {
        minted += 1;
        return tokenExpiringIn(HOUR_S * (minted + 1), `t${minted}`);
      },
    });
    const errors: string[] = [];
    const refreshes: number[] = [];
    client.on("error", (e) => errors.push(e.code));
    client.on("token-refreshed", () => refreshes.push(Date.now()));

    // Three token lifetimes: a session that used to die twice over.
    await vi.advanceTimersByTimeAsync(3 * HOUR_S * 1000);

    expect(errors).toEqual([]);
    expect(refreshes.length).toBeGreaterThanOrEqual(2);
  });

  // A backend blip must not cost the viewer their stream: the current token is
  // still valid, so the only correct response is to try again.
  it("retries a failed renewal and recovers without surfacing an error", async () => {
    let attempts = 0;
    const client = Mebius.connect({
      token: tokenExpiringIn(HOUR_S),
      getToken: () => {
        attempts += 1;
        if (attempts < 3) throw new Error("backend down");
        return tokenExpiringIn(HOUR_S * 2);
      },
    });
    const errors: string[] = [];
    const refreshes: string[] = [];
    client.on("error", (e) => errors.push(e.code));
    client.on("token-refreshed", () => refreshes.push("ok"));

    await vi.advanceTimersByTimeAsync(HOUR_S * 1000);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(refreshes).toEqual(["ok"]);
    expect(errors).toEqual([]);
  });

  // Retrying forever against a backend that is never coming back would leave a
  // dead player showing a frozen frame with no explanation.
  it("gives up once the current token has actually expired", async () => {
    const client = Mebius.connect({
      token: tokenExpiringIn(120),
      getToken: () => {
        throw new Error("backend down");
      },
    });
    const errors: string[] = [];
    client.on("error", (e) => errors.push(e.code));

    await vi.advanceTimersByTimeAsync(180_000);
    expect(errors).toEqual(["TOKEN_EXPIRED"]);
  });

  // A provider re-serving one cached credential must not spin (refresh, see the
  // same expiry, reschedule immediately, forever) — but it must not end the
  // session early either. A token that is not newer is a FAILED mint: retried
  // under backoff while the current credential is still valid, reported once it
  // genuinely is not.
  it("retries a provider returning a token no newer than the last, then reports once", async () => {
    const stale = tokenExpiringIn(HOUR_S);
    let calls = 0;
    const client = Mebius.connect({
      token: stale,
      getToken: () => {
        calls += 1;
        return stale;
      },
    });
    const errors: string[] = [];
    client.on("error", (e) => errors.push(e.code));

    // Refresh is due a minute before expiry. Through that last minute the old
    // token is still perfectly good, so killing the session here would be worse
    // than having no refresh at all.
    await vi.advanceTimersByTimeAsync((HOUR_S - 30) * 1000);
    expect(errors, "reported expiry while the old token was still valid").toEqual([]);
    expect(calls).toBeGreaterThan(0);

    // Past the real expiry: said once, not in a loop.
    await vi.advanceTimersByTimeAsync(HOUR_S * 1000);
    expect(errors).toEqual(["TOKEN_EXPIRED"]);
  });

  // A listener that throws is the app's bug. It must not become ours: emits run
  // on the SDK's own hot paths, and an exception escaping one used to unwind into
  // route acceptance and tear down a stream that was playing fine.
  it("isolates a listener that throws from the rest of the session", async () => {
    const client = Mebius.connect({
      token: tokenExpiringIn(HOUR_S),
      getToken: () => tokenExpiringIn(HOUR_S * 3),
    });
    const seen: string[] = [];
    client.on("token-refreshed", () => {
      throw new Error("listener bug");
    });
    client.on("token-refreshed", () => seen.push("second listener still ran"));

    await vi.advanceTimersByTimeAsync(HOUR_S * 1000);
    expect(seen).toEqual(["second listener still ran"]);
  });
});

describe("SignalingClient token swap", () => {
  it("builds later URLs with the new token", () => {
    const sig = new SignalingClient("https://engine.example", "old");
    expect(sig.scalePlaylistUrl("s_1")).toContain("token=old");
    sig.setToken("new");
    expect(sig.scalePlaylistUrl("s_1")).toContain("token=new");
    expect(sig.accessToken()).toBe("new");
  });
});

describe("withCurrentToken", () => {
  it("replaces an existing token parameter", () => {
    expect(withCurrentToken("https://g.example/live/s/index.m3u8?token=old", "new")).toBe(
      "https://g.example/live/s/index.m3u8?token=new",
    );
    expect(withCurrentToken("https://g.example/x?a=1&token=old&b=2", "new")).toBe(
      "https://g.example/x?a=1&token=new&b=2",
    );
  });

  // The rule that keeps our credential off a third-party edge.
  it("never adds a token to a URL that had none", () => {
    const edge = "https://edge.vendor.example/live/s.m3u8?wsSecret=abc&wsTime=1";
    expect(withCurrentToken(edge, "new")).toBe(edge);
  });

  it("escapes the token it writes", () => {
    expect(withCurrentToken("https://g.example/x?token=a", "a b&c")).toBe(
      "https://g.example/x?token=a%20b%26c",
    );
  });
});
