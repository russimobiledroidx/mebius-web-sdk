import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InputSender,
  MAX_INPUT_BATCH,
  reconnectDelayMs,
  screenPoint,
  sseParser,
  type ScreenInputEvent,
} from "./internal/screen.js";
import { DEFAULT_RTC_CONFIG } from "./internal/webrtc-util.js";
import { MebiusScreenShare } from "./screen-share.js";
import { MebiusScreenViewer } from "./screen-viewer.js";
import type { ScreenCredentials, ScreenCredentialStore } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("screenPoint", () => {
  const box = { left: 100, top: 50, width: 800, height: 600 };

  it("maps onto the picture, not the bars beside a wide element's narrower picture", () => {
    // 4:3 element, 16:9 picture: contain leaves 75px bars above and below.
    const p = screenPoint(box, 1920, 1080, "contain", 100 + 400, 50 + 75 + 225);
    expect(p).toEqual({ x: 0.5, y: 0.5, inside: true });
    const topLeft = screenPoint(box, 1920, 1080, "contain", 100, 50 + 75);
    expect(topLeft).toEqual({ x: 0, y: 0, inside: true });
  });

  it("clamps a point on the bars to the edge and says it is outside", () => {
    expect(screenPoint(box, 1920, 1080, "contain", 500, 60)).toEqual({
      x: 0.5,
      y: 0,
      inside: false,
    });
  });

  it("handles pillarboxing (tall picture in a wide element)", () => {
    // 1000x1000 picture in 800x600: scaled to 600x600 with 100px bars left and right.
    expect(screenPoint(box, 1000, 1000, "", 100 + 100 + 150, 50 + 300)).toEqual({
      x: 0.25,
      y: 0.5,
      inside: true,
    });
  });

  it("stretches on fill and crops on cover", () => {
    expect(screenPoint(box, 1920, 1080, "fill", 100 + 200, 50 + 150)).toEqual({
      x: 0.25,
      y: 0.25,
      inside: true,
    });
    // cover: scale = max(800/1920, 600/1080) → 1066.67 x 600, 133.33px cropped each side.
    const p = screenPoint(box, 1920, 1080, "cover", 100, 50 + 300)!;
    expect(p.x).toBeCloseTo(133.33 / 1066.67, 3);
    expect(p.y).toBe(0.5);
  });

  it("returns null before the picture has a size", () => {
    expect(screenPoint(box, 0, 0, "contain", 500, 300)).toBeNull();
  });
});

function stubFetch(statuses: number[]) {
  const calls: { url: string; auth: string; events: ScreenInputEvent[] }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        auth: (init.headers as Record<string, string>).Authorization!,
        events: JSON.parse(init.body as string).events,
      });
      const status = statuses.shift() ?? 204;
      return new Response(
        status === 204 ? null : JSON.stringify({ code: "X", message: `m${status}` }),
        { status },
      );
    }),
  );
  return calls;
}

describe("InputSender", () => {
  function sender(refresh: () => Promise<boolean> = async () => false) {
    const frames: (() => void)[] = [];
    const errors: string[] = [];
    let token = "t1";
    const s = new InputSender(
      "https://gw/api/v1/screen/sessions/scr_1/input",
      () => token,
      async () => {
        const ok = await refresh();
        if (ok) token = "t2";
        return ok;
      },
      (e) => errors.push(`${e.code}:${e.message}`),
      (cb) => frames.push(cb),
    );
    return { s, frames, errors };
  }

  it("sends one frame's events in order, at most 64 per request", async () => {
    const calls = stubFetch([]);
    const { s, frames } = sender();
    for (let i = 0; i < 100; i++) s.push({ type: "keydown", key: `K${i}` });
    expect(frames).toHaveLength(1); // one frame scheduled for all of them
    frames[0]!();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.events).toHaveLength(MAX_INPUT_BATCH);
    expect(calls[1]!.events).toHaveLength(100 - MAX_INPUT_BATCH);
    expect(
      [...calls[0]!.events, ...calls[1]!.events].map((e) => (e as { key: string }).key),
    ).toEqual(Array.from({ length: 100 }, (_, i) => `K${i}`));
    expect(calls[0]!.auth).toBe("Bearer t1");
  });

  it("keeps only the last of consecutive moves", async () => {
    const calls = stubFetch([]);
    const { s, frames } = sender();
    s.push({ type: "move", x: 0.1, y: 0.1 });
    s.push({ type: "move", x: 0.2, y: 0.2 });
    s.push({ type: "down", x: 0.2, y: 0.2, button: "left" });
    s.push({ type: "move", x: 0.3, y: 0.3 });
    frames[0]!();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.events.map((e) => e.type)).toEqual(["move", "down", "move"]);
    expect(calls[0]!.events[0]).toEqual({ type: "move", x: 0.2, y: 0.2 });
  });

  it("refreshes the token on a 401 and retries the batch once with the new one", async () => {
    const calls = stubFetch([401]);
    const refresh = vi.fn(async () => true);
    const { s, frames, errors } = sender(refresh);
    s.push({ type: "keydown", key: "KeyA" });
    frames[0]!();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(refresh).toHaveBeenCalledOnce();
    expect(calls.map((c) => c.auth)).toEqual(["Bearer t1", "Bearer t2"]);
    expect(errors).toEqual([]);
  });

  it("gives up after one retry instead of looping on a token that never works", async () => {
    const calls = stubFetch([401, 401]);
    const { s, frames, errors } = sender(async () => true);
    s.push({ type: "keydown", key: "KeyA" });
    frames[0]!();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(calls).toHaveLength(2);
    expect(errors[0]).toBe("TOKEN_EXPIRED:m401");
  });

  it("reports a view-only session with the engine's message", async () => {
    stubFetch([403]);
    const { s, frames, errors } = sender();
    s.push({ type: "keydown", key: "KeyA" });
    frames[0]!();
    await vi.waitFor(() => expect(errors).toEqual(["PERMISSION_DENIED:m403"]));
  });
});

describe("sseParser", () => {
  it("emits each event's data, skips heartbeat comments, survives any chunk boundary", () => {
    const stream =
      ': ping\n\ndata: {"type":"session.start","sessionId":"scr_1"}\n\n: ping\n\r\ndata: a\r\ndata: b\r\n\r\ndata:{"x":1}\n\n';
    const whole: string[] = [];
    sseParser((d) => whole.push(d))(stream);
    expect(whole).toEqual(['{"type":"session.start","sessionId":"scr_1"}', "a\nb", '{"x":1}']);
    // Every split point yields the same events.
    for (let i = 1; i < stream.length; i++) {
      const seen: string[] = [];
      const feed = sseParser((d) => seen.push(d));
      feed(stream.slice(0, i));
      feed(stream.slice(i));
      expect(seen).toEqual(whole);
    }
  });

  it("holds an event until its blank line arrives", () => {
    const seen: string[] = [];
    const feed = sseParser((d) => seen.push(d));
    feed("data: x\n");
    expect(seen).toEqual([]);
    feed("\n");
    expect(seen).toEqual(["x"]);
  });
});

describe("reconnectDelayMs", () => {
  it("doubles from 1s up to 30s", () => {
    const none = () => 0;
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((a) => reconnectDelayMs(a, none))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });

  it("adds up to 20% jitter", () => {
    expect(reconnectDelayMs(0, () => 1)).toBe(1200);
    expect(reconnectDelayMs(10, () => 0.5)).toBe(33000);
  });
});

// ---- WebRTC fakes ---------------------------------------------------------

const pcConfigs: RTCConfiguration[] = [];

class FakePc {
  iceGatheringState = "complete";
  connectionState = "connected";
  localDescription = { sdp: "offer" };
  senders: { track: { kind: string; stop(): void } }[] = [];
  closed = false;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  constructor(config: RTCConfiguration) {
    pcConfigs.push(config);
  }
  addTrack(track: { kind: string; stop(): void }) {
    this.senders.push({ track });
  }
  addTransceiver() {}
  getTransceivers() {
    return [];
  }
  getSenders() {
    return this.senders.map((s) => ({
      ...s,
      getParameters: () => ({}),
      setParameters: async () => undefined,
    }));
  }
  async createOffer() {
    return { type: "offer", sdp: "offer" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {
    this.closed = true;
  }
}

function stubWebRtc() {
  pcConfigs.length = 0;
  vi.stubGlobal("RTCPeerConnection", FakePc);
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => null });
  vi.stubGlobal("MediaStream", class {});
}

const TURN: RTCIceServer = { urls: ["turn:turn.example:3478"], username: "u", credential: "c" };

describe("MebiusScreenViewer.watch", () => {
  class FakeVideo {
    srcObject = null;
    removeAttribute() {}
    load() {}
  }

  it("retries while the device has not started sending, then uses the session's relay servers too", async () => {
    vi.stubGlobal("HTMLVideoElement", FakeVideo);
    stubWebRtc();
    const urls: string[] = [];
    const statuses = [404, 404, 201];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const status = statuses.shift()!;
        return new Response(status === 201 ? "answer" : null, { status });
      }),
    );
    vi.useFakeTimers();
    const viewer = new MebiusScreenViewer("https://gw/");
    const watching = viewer.watch(
      { sessionId: "scr_1", token: "view", iceServers: [TURN] },
      new FakeVideo() as unknown as HTMLVideoElement,
    );
    await vi.advanceTimersByTimeAsync(2500);
    await watching;
    expect(urls).toEqual(Array(3).fill("https://gw/whep/scr_1?token=view"));
    expect(pcConfigs.at(-1)).toEqual({ iceServers: [...DEFAULT_RTC_CONFIG.iceServers!, TURN] });
    viewer.close();
  });

  it("does not retry a rejected token", async () => {
    vi.stubGlobal("HTMLVideoElement", FakeVideo);
    stubWebRtc();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);
    const viewer = new MebiusScreenViewer("https://gw");
    await expect(
      viewer.watch(
        { sessionId: "scr_1", token: "bad" },
        new FakeVideo() as unknown as HTMLVideoElement,
      ),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(pcConfigs[0]).toBe(DEFAULT_RTC_CONFIG); // no relay servers: unchanged default
  });
});

describe("MebiusScreenShare", () => {
  function memoryStore(
    initial: ScreenCredentials | null,
  ): ScreenCredentialStore & { value: ScreenCredentials | null } {
    return {
      value: initial,
      load() {
        return this.value;
      },
      save(c) {
        this.value = c;
      },
      clear() {
        this.value = null;
      },
    };
  }

  function setup(eventsStatus = 200) {
    stubWebRtc();
    const sourceTrack = { kind: "video", contentHint: "", stop: vi.fn(), addEventListener() {} };
    const cloneTrack = { kind: "video", stop: vi.fn() };
    const source = {
      getTracks: () => [sourceTrack],
      getVideoTracks: () => [sourceTrack],
      clone: () => ({ getTracks: () => [cloneTrack], getVideoTracks: () => [cloneTrack] }),
    };
    const getDisplayMedia = vi.fn(async () => source);
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });

    let push: (s: string) => void = () => undefined;
    let close: () => void = () => undefined;
    const requests: { method: string; url: string; auth?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
        requests.push({ method: init.method ?? "GET", url, auth });
        if (url.endsWith("/agent/events")) {
          if (eventsStatus !== 200)
            return new Response(JSON.stringify({ message: "revoked" }), { status: eventsStatus });
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              const enc = new TextEncoder();
              push = (s) => c.enqueue(enc.encode(s));
              close = () => c.close();
            },
          });
          return new Response(body, { status: 200 });
        }
        return new Response("answer", { status: 201 }); // the publish exchange
      }),
    );
    const store = memoryStore({ deviceId: "dev_1", deviceSecret: "dsk_1" });
    const share = new MebiusScreenShare("https://gw", { credentials: store });
    const seen: string[] = [];
    share.on("viewing", (s) => seen.push(`viewing:${s.sessionId}:${s.mode}:${s.userId}`));
    share.on("ended", (s) => seen.push(`ended:${s.sessionId}`));
    share.on("stopped", () => seen.push("stopped"));
    share.on("error", (e) => seen.push(`error:${e.code}`));
    return {
      share,
      store,
      seen,
      requests,
      sourceTrack,
      cloneTrack,
      getDisplayMedia,
      send: (s: string) => push(s),
      close: () => close(),
    };
  }

  const start = (extra: object = {}) =>
    `data: ${JSON.stringify({ type: "session.start", sessionId: "scr_1", mode: "control", userId: "admin-42", publishToken: "pub", maxBitrateKbps: 1500, ...extra })}\n\n`;

  it("asks for the screen first, then goes online with the device secret", async () => {
    const t = setup();
    await t.share.start();
    await tick();
    expect(t.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(t.sourceTrack.contentHint).toBe("detail");
    expect(t.requests[0]).toEqual({
      method: "GET",
      url: "https://gw/api/v1/screen/agent/events",
      auth: "Bearer dsk_1",
    });
    await t.share.stop();
  });

  it("publishes on session.start and stops on session.stop, keeping the shared screen", async () => {
    const t = setup();
    await t.share.start();
    await tick();
    t.send(": ping\n\n");
    t.send(start({ iceServers: [TURN] }));
    await vi.waitFor(() => expect(t.requests.some((r) => r.method === "POST")).toBe(true));
    expect(t.requests.find((r) => r.method === "POST")!.url).toBe(
      "https://gw/whip/scr_1?token=pub",
    );
    expect(pcConfigs.at(-1)).toEqual({ iceServers: [...DEFAULT_RTC_CONFIG.iceServers!, TURN] });
    expect(t.seen).toEqual(["viewing:scr_1:control:admin-42"]);

    t.send(
      'data: {"type":"input","sessionId":"scr_1","input":[{"type":"move","x":0.5,"y":0.5}]}\n\n',
    );
    t.send('data: {"type":"session.stop","sessionId":"scr_1"}\n\n');
    await vi.waitFor(() =>
      expect(t.seen).toEqual(["viewing:scr_1:control:admin-42", "ended:scr_1"]),
    );
    expect(t.cloneTrack.stop).toHaveBeenCalled();
    expect(t.sourceTrack.stop).not.toHaveBeenCalled(); // still sharing, ready for the next session

    await t.share.stop();
    expect(t.sourceTrack.stop).toHaveBeenCalled();
    expect(t.seen.at(-1)).toBe("stopped");
  });

  it("publishes with the default configuration when the session carries no relay servers", async () => {
    const t = setup();
    await t.share.start();
    await tick();
    t.send(start());
    await vi.waitFor(() => expect(t.requests.some((r) => r.method === "POST")).toBe(true));
    expect(pcConfigs.at(-1)).toBe(DEFAULT_RTC_CONFIG);
    await t.share.stop();
    expect(t.seen).toEqual(["viewing:scr_1:control:admin-42", "ended:scr_1", "stopped"]);
  });

  it("ends the session when the event stream drops", async () => {
    const t = setup();
    await t.share.start();
    await tick();
    t.send(start());
    await vi.waitFor(() => expect(t.seen).toContain("viewing:scr_1:control:admin-42"));
    t.close();
    await vi.waitFor(() => expect(t.seen).toContain("ended:scr_1"));
    await t.share.stop();
  });

  it("forgets revoked credentials and stops instead of reconnecting", async () => {
    const t = setup(401);
    await t.share.start();
    await vi.waitFor(() => expect(t.seen).toEqual(["error:TOKEN_EXPIRED", "stopped"]));
    expect(t.store.value).toBeNull();
    expect(t.requests).toHaveLength(1);
  });

  it("enrolls only when it has no credentials", async () => {
    const t = setup();
    await t.share.enrollIfNeeded("enr_1");
    expect(t.requests).toEqual([]);
    t.store.value = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(JSON.parse(init.body as string)).toEqual({
          enrollToken: "enr_1",
          name: "browser",
          os: "web",
        });
        return new Response(JSON.stringify({ deviceId: "dev_2", deviceSecret: "dsk_2" }), {
          status: 201,
        });
      }),
    );
    await t.share.enrollIfNeeded("enr_1");
    expect(t.store.value).toEqual({ deviceId: "dev_2", deviceSecret: "dsk_2" });
  });
});
