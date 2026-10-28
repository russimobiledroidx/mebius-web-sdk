import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InputSender,
  MAX_INPUT_BATCH,
  MIN_INPUT_INTERVAL_MS,
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
const pcs: FakePc[] = [];

class FakePc {
  iceGatheringState = "complete";
  connectionState = "connected";
  localDescription = { sdp: "offer" };
  senders: { track: { kind: string; stop(): void } }[] = [];
  closed = false;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  dtls = Object.assign(new EventTarget(), { state: "connected" });
  constructor(config: RTCConfiguration) {
    pcConfigs.push(config);
    pcs.push(this);
  }
  getReceivers() {
    return [{ transport: this.dtls }];
  }
  /** The server closed the session: ICE still looks connected, the secure transport does not. */
  remoteClose() {
    this.dtls.state = "closed";
    this.dtls.dispatchEvent(new Event("statechange"));
  }
  fail() {
    this.connectionState = "failed";
    (this.onconnectionstatechange as () => void)();
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
  pcs.length = 0;
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
  it("keeps handling events after a malformed or failing one, and still stops", async () => {
    const t = setup();
    await t.share.start();
    await tick();
    t.send("data: null\n\n");
    t.send('data: {"type":"session.start"}\n\n'); // no sessionId / publishToken
    t.send("data: 42\n\n");
    t.send(start());
    await vi.waitFor(() => expect(t.seen).toContain("viewing:scr_1:control:admin-42"));
    await t.share.stop();
    expect(t.sourceTrack.stop).toHaveBeenCalled();
    expect(t.seen.at(-1)).toBe("stopped");
  });

  it("opens one picker for a double click, and a stop during the picker backs out", async () => {
    const t = setup();
    let pick: (s: unknown) => void = () => undefined;
    const source = await t.getDisplayMedia();
    t.getDisplayMedia.mockClear();
    t.getDisplayMedia.mockImplementation(() => new Promise((r) => (pick = r)) as never);
    const a = t.share.start();
    const b = t.share.start();
    expect(t.getDisplayMedia).toHaveBeenCalledOnce();
    await t.share.stop();
    pick(source);
    await Promise.all([a, b]);
    await tick();
    expect(t.sourceTrack.stop).toHaveBeenCalled();
    expect(t.requests).toEqual([]); // never went online
  });

  it("keeps the credentials on a 403 (only a 401 means the secret is dead)", async () => {
    const t = setup(403);
    await t.share.start();
    await vi.waitFor(() => expect(t.seen).toEqual(["error:PERMISSION_DENIED", "stopped"]));
    expect(t.store.value).not.toBeNull();
  });

  it("saves nothing when enrollment returns no credentials", async () => {
    const t = setup();
    t.store.value = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ deviceId: "dev_2" }), { status: 201 })),
    );
    await expect(t.share.enrollIfNeeded("enr_1")).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
    });
    expect(t.store.value).toBeNull();
  });

  it("keeps each engine's device apart in localStorage", async () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ deviceId: "dev_9", deviceSecret: "dsk_9" }), {
            status: 201,
          }),
      ),
    );
    await new MebiusScreenShare("https://a.example/").enrollIfNeeded("enr_1");
    expect([...data.keys()]).toEqual(["mebius.screen.device:https://a.example"]);
    data.set("mebius.screen.device:https://b.example", "not json");
    await new MebiusScreenShare("https://b.example").enrollIfNeeded("enr_2"); // corrupt entry: enrolls again
    expect(JSON.parse(data.get("mebius.screen.device:https://b.example")!)).toEqual({
      deviceId: "dev_9",
      deviceSecret: "dsk_9",
    });
  });
});

// ---- viewer: the session ending, control input ------------------------------

class FakeElement extends EventTarget {
  srcObject = null;
  tabIndex = -1;
  style = { touchAction: "" };
  videoWidth = 1000;
  videoHeight = 1000;
  removeAttribute() {}
  load() {}
  focus() {}
  setPointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1000, height: 1000 };
  }
}

function viewerEnv(whepStatuses: number[]) {
  vi.stubGlobal("HTMLVideoElement", FakeElement);
  vi.stubGlobal("getComputedStyle", () => ({ objectFit: "fill" }));
  stubWebRtc();
  const inputs: ScreenInputEvent[][] = [];
  const whep: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes("/input")) {
        inputs.push(JSON.parse(init.body as string).events);
        return new Response(null, { status: 204 });
      }
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      whep.push(url);
      const status = whepStatuses.shift() ?? 201;
      return status === 201
        ? new Response("answer", { status })
        : new Response(JSON.stringify({ code: "FORBIDDEN", message: "session ended" }), { status });
    }),
  );
  const video = new FakeElement();
  const viewer = new MebiusScreenViewer("https://gw");
  const seen: string[] = [];
  viewer.on("ended", () => seen.push("ended"));
  viewer.on("error", (e) => seen.push(`error:${e.code}`));
  return { video, viewer, seen, inputs, whep, el: video as unknown as HTMLVideoElement };
}

describe("MebiusScreenViewer after the session ends", () => {
  it("ends when the server closes the picture and refuses the reopen", async () => {
    const t = viewerEnv([201, 403]);
    await t.viewer.watch({ sessionId: "scr_1", token: "view" }, t.el);
    pcs[0]!.remoteClose(); // ICE still "connected": only the secure transport knows
    await vi.waitFor(() => expect(t.seen).toEqual(["ended"]));
    expect(t.whep).toHaveLength(2);
  });

  it("ends at once when the media server refuses the reopen with 400", async () => {
    // The media server turns the auth refusal ("session ended") into a 400.
    const t = viewerEnv([201, 400]);
    await t.viewer.watch({ sessionId: "scr_1", token: "view" }, t.el);
    pcs[0]!.remoteClose();
    await vi.waitFor(() => expect(t.seen).toEqual(["ended"]));
    expect(t.whep).toHaveLength(2);
  });

  it("ends on a failed connection whose reopen is refused", async () => {
    const t = viewerEnv([201, 404]);
    await t.viewer.watch({ sessionId: "scr_1", token: "view" }, t.el);
    pcs[0]!.fail();
    await vi.waitFor(() => expect(t.seen).toEqual(["ended"]));
  });

  it("keeps watching when the reopen is accepted (a network blip)", async () => {
    const t = viewerEnv([201, 201]);
    await t.viewer.watch({ sessionId: "scr_1", token: "view" }, t.el);
    pcs[0]!.fail();
    await vi.waitFor(() => expect(t.whep).toHaveLength(2));
    await tick();
    expect(t.seen).toEqual([]);
    expect(pcs[0]!.closed).toBe(true);
    t.viewer.close();
  });

  it("settles quietly when closed during watch()", async () => {
    const t = viewerEnv([]);
    const watching = t.viewer.watch({ sessionId: "scr_1", token: "view" }, t.el);
    t.viewer.close();
    await expect(watching).resolves.toBeUndefined();
  });
});

describe("MebiusScreenViewer control", () => {
  const pointer = (type: string, buttons: number, x = 500, y = 500) =>
    Object.assign(new Event(type), { clientX: x, clientY: y, buttons, pointerId: 1 });
  const key = (type: string, code: string, repeat = false) =>
    Object.assign(new Event(type), { code, repeat });

  async function controlled() {
    const t = viewerEnv([]);
    await t.viewer.watch({ sessionId: "scr_1", token: "view" }, t.el);
    t.viewer.enableControl({ refreshToken: async () => "view" });
    const sent = async () => {
      await new Promise((r) => setTimeout(r, 60));
      return t.inputs
        .flat()
        .map((e) =>
          "button" in e ? `${e.type}:${e.button}` : "key" in e ? `${e.type}:${e.key}` : e.type,
        );
    };
    return { ...t, sent };
  }

  it("follows the button mask: chords, no release without a press, presses only on the picture", async () => {
    const t = await controlled();
    t.video.dispatchEvent(pointer("pointerup", 0)); // nothing was pressed
    t.video.dispatchEvent(pointer("pointerdown", 1));
    t.video.dispatchEvent(pointer("pointermove", 3)); // right pressed while left is held
    t.video.dispatchEvent(pointer("pointerup", 2));
    t.video.dispatchEvent(pointer("pointerup", 0));
    expect(await t.sent()).toEqual(["down:left", "move", "down:right", "up:left", "up:right"]);
    expect(t.video.style.touchAction).toBe("none");
    t.viewer.close();
  });

  it("releases held buttons on pointercancel and held keys and buttons on disableControl", async () => {
    const t = await controlled();
    t.video.dispatchEvent(pointer("pointerdown", 1));
    t.video.dispatchEvent(pointer("pointercancel", 0));
    t.video.dispatchEvent(pointer("pointerdown", 4));
    t.video.dispatchEvent(key("keydown", "ShiftLeft"));
    t.viewer.disableControl();
    expect(await t.sent()).toEqual([
      "down:left",
      "up:left",
      "down:middle",
      "keydown:ShiftLeft",
      "up:middle",
      "keyup:ShiftLeft",
    ]);
    expect(t.video.style.touchAction).toBe("");
    t.viewer.close();
  });

  it("skips auto-repeat and releases keys held under Meta when Meta goes up", async () => {
    const t = await controlled();
    t.video.dispatchEvent(key("keydown", "MetaLeft"));
    t.video.dispatchEvent(key("keydown", "KeyC"));
    t.video.dispatchEvent(key("keydown", "KeyC", true));
    t.video.dispatchEvent(key("keyup", "MetaLeft")); // macOS sends no keyup for KeyC
    t.video.dispatchEvent(key("keyup", "KeyC")); // a late one is not sent twice
    expect(await t.sent()).toEqual([
      "keydown:MetaLeft",
      "keydown:KeyC",
      "keyup:MetaLeft",
      "keyup:KeyC",
    ]);
    t.viewer.close();
  });
});

describe("InputSender pacing and outages", () => {
  function paced(statuses: number[]) {
    const at: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        at.push(Date.now());
        return new Response(null, { status: statuses.shift() ?? 204 });
      }),
    );
    const errors: string[] = [];
    const s = new InputSender(
      "https://gw/input",
      () => "t",
      async () => false,
      (e) => errors.push(e.code),
      (cb) => cb(),
    );
    return { s, at, errors };
  }

  it("leaves at least 20ms between requests, batching what arrives meanwhile", async () => {
    const t = paced([]);
    t.s.push({ type: "keydown", key: "K0" });
    await vi.waitFor(() => expect(t.at).toHaveLength(1));
    t.s.push({ type: "keydown", key: "K1" });
    t.s.push({ type: "keyup", key: "K1" });
    await vi.waitFor(() => expect(t.at).toHaveLength(2));
    expect(t.at[1]! - t.at[0]!).toBeGreaterThanOrEqual(MIN_INPUT_INTERVAL_MS - 1);
  });

  it("retries a rate-limited batch instead of dropping it", async () => {
    const t = paced([429]);
    t.s.push({ type: "down", x: 0.5, y: 0.5, button: "left" });
    await vi.waitFor(() => expect(t.at).toHaveLength(2), { timeout: 2000 });
    expect(t.errors).toEqual([]);
  });

  it("reports an outage once, and again only after a success", async () => {
    const t = paced([500, 500, 204, 500]);
    for (let i = 0; i < 4; i++) {
      t.s.push({ type: "keydown", key: `K${i}` });
      await vi.waitFor(() => expect(t.at).toHaveLength(i + 1));
    }
    await tick();
    expect(t.errors).toEqual(["CONNECTION_FAILED", "CONNECTION_FAILED"]);
  });
});

describe("MebiusScreenViewer token refresh timing", () => {
  const jwt = (expMs: number) =>
    `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url")}.s`;

  it("waits at least 5s, and does not re-arm for a token that is not newer", async () => {
    const t = viewerEnv([]);
    const short = jwt(Date.now() + 30_000); // inside the 60s margin
    await t.viewer.watch({ sessionId: "scr_1", token: short }, t.el);
    vi.useFakeTimers();
    const refresh = vi.fn(async () => short);
    t.viewer.enableControl({ refreshToken: refresh });
    await vi.advanceTimersByTimeAsync(4900);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledOnce();
    t.viewer.close();
  });
});
