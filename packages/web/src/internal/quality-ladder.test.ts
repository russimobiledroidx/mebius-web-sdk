import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlvViewTransport } from "./balanced-view-transport.js";
import { HlsViewTransport } from "./scale-view-transport.js";
import { SignalingClient } from "./signaling.js";
import { createViewCandidates } from "./transport.js";
import { MebiusPlayer } from "../player.js";
import type { MebiusRendition, QualityChange } from "../types.js";

/**
 * T4: the rendition ladder. A delivery that carries `renditions` gets a quality
 * menu; one that does not must play exactly as before — that half is the one
 * existing integrators depend on, so it is pinned as hard as the feature.
 */

const GATEWAY = "https://gateway.example";
const sig = () => new SignalingClient(GATEWAY, "tok");

const LADDER: MebiusRendition[] = [
  { id: "1080p", height: 1080, bitrateKbps: 5000, path: "/d/fast/s1/1080p" },
  { id: "720p", height: 720, bitrateKbps: 2800, path: "/d/fast/s1/720p" },
  { id: "480p", height: 480, bitrateKbps: 1000, path: "/d/fast/s1/480p" },
];
const WIDE_LADDER = LADDER.map((r) => ({ ...r, path: r.path.replace("/fast/", "/wide/") }));

// --- flv.js double: records every URL a player was created for. -------------
const flvOpened: string[] = [];
vi.mock("flv.js", () => ({
  default: {
    isSupported: () => true,
    Events: { ERROR: "error" },
    createPlayer: (source: { url: string }) => {
      flvOpened.push(source.url);
      return {
        on() {},
        attachMediaElement() {},
        load() {},
        unload() {},
        detachMediaElement() {},
        destroy() {},
      };
    },
  },
}));

// --- hls.js double: levels and handlers are driven by the test. --------------
class FakeHls {
  static instances: FakeHls[] = [];
  static isSupported = () => true;
  static Events = { ERROR: "e", MANIFEST_PARSED: "mp", LEVEL_SWITCHED: "ls" };
  static DefaultConfig = { loader: class {} };
  levels: { height: number; bitrate: number }[] = [];
  currentLevel = -1;
  autoLevelCapping = -1;
  handlers = new Map<string, () => void>();
  loaded = "";
  constructor() {
    FakeHls.instances.push(this);
  }
  on(evt: string, cb: () => void) {
    this.handlers.set(evt, cb);
  }
  loadSource(url: string) {
    this.loaded = url;
  }
  attachMedia() {}
  destroy() {}
  /** Levels ascending, as hls.js orders a master. */
  parse() {
    this.levels = [480, 720, 1080].map((height) => ({ height, bitrate: height * 1000 }));
    this.handlers.get("mp")?.();
  }
}
vi.mock("hls.js", () => ({ default: FakeHls }));

/** A video element that actually dispatches the events the transports listen to. */
class FakeVideo {
  currentTime = 1; // already moving: the FLV audio-retry probe resolves at once
  paused = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  playsInline = false;
  src = "";
  srcObject: unknown = null;
  buffered = { length: 0, end: () => 0 };
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, cb: () => void, opts?: { signal?: AbortSignal }) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
    opts?.signal?.addEventListener("abort", () => this.listeners.get(type)?.delete(cb));
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }
  dispatch(type: string) {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }
  removeAttribute() {}
  load() {}
  canPlayType() {
    return "";
  }
  play() {
    return Promise.resolve();
  }
}
// @ts-expect-error — test double for a browser global
globalThis.HTMLVideoElement = FakeVideo;
// @ts-expect-error — test double for a browser global
globalThis.MediaSource ??= class {};

const el = () => new FakeVideo();
const asVideo = (v: FakeVideo) => v as unknown as HTMLVideoElement;
const pathOf = (url: string) => new URL(url).pathname;

beforeEach(() => {
  flvOpened.length = 0;
  FakeHls.instances.length = 0;
});

describe("no renditions: behaviour unchanged", () => {
  it("FLV opens the delivery's own path, offers nothing, and ignores cap/stalls", async () => {
    const t = new FlvViewTransport(sig(), "/d/fast/s1");
    t.setMaxQuality(480);
    const v = el();
    await t.start("s1", asVideo(v));
    expect(flvOpened.map(pathOf)).toEqual(["/d/fast/s1"]);
    expect(new URL(flvOpened[0]!).searchParams.get("token")).toBe("tok");
    expect(t.qualities()).toEqual([]);

    v.dispatch("playing");
    for (let i = 0; i < 5; i++) {
      v.dispatch("waiting");
      v.dispatch("playing");
    }
    expect(flvOpened).toHaveLength(1); // stalls never reopen without a ladder
  });

  it("HLS loads the same playlist, hooks no level events, and never caps", async () => {
    const t = new HlsViewTransport(sig(), "/d/wide/s1");
    await t.start("s1", asVideo(el()));
    const hls = FakeHls.instances[0]!;
    expect(pathOf(hls.loaded)).toBe("/d/wide/s1");
    expect([...hls.handlers.keys()]).toEqual(["e"]);
    hls.parse();
    t.setMaxQuality(480);
    expect(hls.autoLevelCapping).toBe(-1);
    expect(t.qualities()).toEqual([]);
  });

  it("a deliveries list without renditions still gives a player with no qualities", async () => {
    const p = new MebiusPlayer(sig(), {}, [{ kind: "fast", path: "/d/fast/s1" }]);
    const changes: QualityChange[] = [];
    p.on("quality-changed", (c) => changes.push(c));
    await p.play("s1", asVideo(el()));
    expect(p.route).toBe("fast");
    expect(p.qualities).toEqual([]);
    expect(changes).toEqual([]);
    await expect(p.setQuality("720p")).rejects.toThrow();
    await p.stop();
  });
});

describe("qualities mapping", () => {
  it("passes renditions from the delivery to fast and wide routes", () => {
    const [fast, wide] = createViewCandidates("auto", sig(), [
      { kind: "fast", path: "/d/fast/s1", renditions: LADDER },
      { kind: "wide", path: "/d/wide/s1", renditions: WIDE_LADDER },
    ]);
    const ids = ["1080p", "720p", "480p"];
    expect(fast!.qualities!().map((q) => q.id)).toEqual(ids);
    expect(wide!.qualities!().map((q) => q.id)).toEqual(ids);
    // The path is an internal detail and never reaches the public shape.
    expect(fast!.qualities!()[0]).toEqual({ id: "1080p", label: "1080p", height: 1080, bitrateKbps: 5000 });
  });

  it("player exposes the ladder and announces what is on screen", async () => {
    const p = new MebiusPlayer(sig(), {}, [{ kind: "fast", path: "/d/fast/s1", renditions: LADDER }]);
    const changes: QualityChange[] = [];
    p.on("quality-changed", (c) => changes.push(c));
    await p.play("s1", asVideo(el()));
    expect(p.qualities.map((q) => q.id)).toEqual(["1080p", "720p", "480p"]);
    expect(changes).toEqual([{ id: "1080p", auto: true }]);
    await p.stop();
  });
});

describe("HLS route (hls.js)", () => {
  async function started() {
    const t = new HlsViewTransport(sig(), "/d/wide/s1", undefined, WIDE_LADDER);
    const changes: QualityChange[] = [];
    t.onQualityChanged((c) => changes.push(c));
    await t.start("s1", asVideo(el()));
    const hls = FakeHls.instances[0]!;
    hls.parse();
    return { t, hls, changes };
  }

  it("names levels by height and switches them in place", async () => {
    const { t, hls, changes } = await started();
    expect(t.qualities().map((q) => q.id)).toEqual(["1080p", "720p", "480p"]);

    await t.setQuality("720p");
    expect(hls.currentLevel).toBe(1); // levels are ascending: 480, 720, 1080
    hls.handlers.get("ls")!();
    expect(changes.at(-1)).toEqual({ id: "720p", auto: false });

    await t.setQuality("auto");
    expect(hls.currentLevel).toBe(-1);
    expect(changes.at(-1)!.auto).toBe(true);
    expect(FakeHls.instances).toHaveLength(1); // never torn down to switch
  });

  it("caps auto at the highest level within maxQuality", async () => {
    const { t, hls } = await started();
    t.setMaxQuality(720);
    expect(hls.autoLevelCapping).toBe(1);
    t.setMaxQuality(1000);
    expect(hls.autoLevelCapping).toBe(1);
    t.setMaxQuality(240); // below the ladder: the lowest rung, not "uncapped"
    expect(hls.autoLevelCapping).toBe(0);
    t.setMaxQuality(Infinity);
    expect(hls.autoLevelCapping).toBe(-1);
  });

  it("applies a cap set before the master was parsed", async () => {
    const t = new HlsViewTransport(sig(), "/d/wide/s1", undefined, WIDE_LADDER);
    t.setMaxQuality(480);
    await t.start("s1", asVideo(el()));
    FakeHls.instances[0]!.parse();
    expect(FakeHls.instances[0]!.autoLevelCapping).toBe(0);
  });
});

describe("FLV route (flv.js)", () => {
  async function started(maxHeight?: number) {
    const t = new FlvViewTransport(sig(), "/d/fast/s1", undefined, LADDER);
    if (maxHeight) t.setMaxQuality(maxHeight);
    const changes: QualityChange[] = [];
    t.onQualityChanged((c) => changes.push(c));
    const v = el();
    await t.start("s1", asVideo(v));
    v.dispatch("playing");
    return { t, v, changes };
  }

  it("auto opens the highest rung within the cap", async () => {
    await started(720);
    expect(flvOpened.map(pathOf)).toEqual(["/d/fast/s1/720p"]);
  });

  it("a manual pick reopens on that rung's path with the same token, keeping mute and volume", async () => {
    const { t, v, changes } = await started();
    v.muted = true;
    v.volume = 0.4;
    await t.setQuality("480p");
    expect(flvOpened.map(pathOf)).toEqual(["/d/fast/s1/1080p", "/d/fast/s1/480p"]);
    expect(new URL(flvOpened[1]!).searchParams.get("token")).toBe("tok");
    expect(v.muted).toBe(true);
    expect(v.volume).toBe(0.4);
    expect(changes.at(-1)).toEqual({ id: "480p", auto: false });
  });

  it("auto steps down one rung after two stalls within the window, and not on one", async () => {
    const now = vi.spyOn(Date, "now");
    try {
      const { v, changes } = await started();
      const stall = (atMs: number) => {
        now.mockReturnValue(atMs);
        v.dispatch("waiting");
        v.dispatch("waiting"); // flv.js repeats it inside one stall: still one
        v.dispatch("playing");
      };
      stall(0);
      stall(25_000); // outside the 20s window of the first: no step
      expect(flvOpened).toHaveLength(1);
      stall(30_000);
      expect(flvOpened.map(pathOf).at(-1)).toBe("/d/fast/s1/720p");
      expect(changes.at(-1)).toEqual({ id: "720p", auto: true });
    } finally {
      now.mockRestore();
    }
  });

  it("does not step down a manual pick", async () => {
    const { t, v } = await started();
    await t.setQuality("1080p"); // already open: no reopen
    expect(flvOpened).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      v.dispatch("waiting");
      v.dispatch("playing");
    }
    expect(flvOpened).toHaveLength(1);
  });
});
