import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlvViewTransport } from "./balanced-view-transport.js";
import { HlsViewTransport } from "./scale-view-transport.js";
import { SignalingClient } from "./signaling.js";
import { createViewCandidates, defaultQualityPrefs, type QualityPrefs } from "./transport.js";
import { MebiusPlayer } from "../player.js";
import type { MebiusRendition, QualityChange } from "../types.js";

/**
 * The rendition ladder. A delivery that carries `renditions` gets a quality
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

// --- flv.js double: records every player it creates. -----------------------
type FlvOpen = { url: string; hasAudio?: boolean; onError?: (...args: unknown[]) => void };
const flvOpened: FlvOpen[] = [];
vi.mock("flv.js", () => ({
  default: {
    isSupported: () => true,
    Events: { ERROR: "error" },
    createPlayer: (source: { url: string; hasAudio?: boolean }) => {
      const open: FlvOpen = { url: source.url, hasAudio: source.hasAudio };
      flvOpened.push(open);
      return {
        on(_evt: string, cb: (...args: unknown[]) => void) {
          open.onError = cb;
        },
        attachMediaElement() {},
        load() {},
        unload() {},
        detachMediaElement() {},
        destroy() {},
      };
    },
  },
}));

// --- hls.js double: levels and handlers are driven by the test, and every
// level-control write is logged so "no flush" can be asserted. ---------------
class FakeHls {
  static instances: FakeHls[] = [];
  static supported = true;
  static isSupported = () => FakeHls.supported;
  static Events = { ERROR: "e", MANIFEST_PARSED: "mp", LEVEL_SWITCHED: "ls" };
  static DefaultConfig = { loader: class {} };
  levels: { height: number; bitrate: number }[] = [];
  playing = -1;
  autoLevelCapping = -1;
  writes: [string, number][] = [];
  handlers = new Map<string, (evt?: unknown, data?: unknown) => void>();
  sources: string[] = [];
  constructor() {
    FakeHls.instances.push(this);
  }
  get currentLevel() {
    return this.playing;
  }
  set currentLevel(v: number) {
    this.writes.push(["currentLevel", v]);
  }
  set nextLevel(v: number) {
    this.writes.push(["nextLevel", v]);
  }
  set loadLevel(v: number) {
    this.writes.push(["loadLevel", v]);
  }
  on(evt: string, cb: (evt?: unknown, data?: unknown) => void) {
    this.handlers.set(evt, cb);
  }
  loadSource(url: string) {
    this.sources.push(url);
  }
  attachMedia() {}
  destroy() {}
  /** Levels ascending, as hls.js orders a master. */
  parse(heights = [480, 720, 1080]) {
    this.levels = heights.map((height) => ({ height, bitrate: height * 1000 }));
    this.handlers.get("mp")?.();
  }
  /** The picture moved to level `i`. */
  switched(i: number) {
    this.playing = i;
    this.handlers.get("ls")?.();
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
  seeking = false;
  /** When true, play() with sound is refused the way an autoplay policy does. */
  blockSound = false;
  src = "";
  srcObject: unknown = null;
  buffered: { length: number; end: () => number } = { length: 0, end: () => 0 };
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
    return "maybe";
  }
  play() {
    if (this.blockSound && !this.muted) {
      return Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    }
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
const opened = () => flvOpened.map((o) => pathOf(o.url));
const prefs = (p: Partial<QualityPrefs> = {}): QualityPrefs => ({ ...defaultQualityPrefs(), ...p });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  flvOpened.length = 0;
  FakeHls.instances.length = 0;
  FakeHls.supported = true;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("no renditions: behaviour unchanged", () => {
  it("FLV opens the delivery's own path, offers nothing, and ignores every quality setting", async () => {
    const q = prefs({ maxHeight: 480, allowed: ["480p"] });
    const t = new FlvViewTransport(sig(), "/d/fast/s1", undefined, [], q);
    const v = el();
    await t.start("s1", asVideo(v));
    expect(opened()).toEqual(["/d/fast/s1"]);
    expect(new URL(flvOpened[0]!.url).search).toBe("?token=tok");
    expect(t.qualities()).toEqual([]);

    v.dispatch("playing");
    for (let i = 0; i < 5; i++) {
      v.dispatch("waiting");
      v.dispatch("playing");
    }
    q.selected = "720p";
    await t.applyQuality();
    expect(flvOpened).toHaveLength(1); // nothing ever reopens without a ladder
  });

  it("HLS loads the same playlist, hooks no level events, and never touches levels", async () => {
    const q = prefs({ maxHeight: 480, allowed: ["480p"] });
    const t = new HlsViewTransport(sig(), "/d/wide/s1", undefined, [], q);
    await t.start("s1", asVideo(el()));
    const hls = FakeHls.instances[0]!;
    expect(hls.sources).toHaveLength(1);
    expect(new URL(hls.sources[0]!).search).toBe("?token=tok"); // no q
    expect([...hls.handlers.keys()]).toEqual(["e"]);
    hls.parse();
    await t.applyQuality();
    expect(hls.writes).toEqual([]); // no flush, no pin
    expect(hls.autoLevelCapping).toBe(-1);
    expect(t.qualities()).toEqual([]);
  });

  it("a player on deliveries without renditions announces nothing and changes nothing", async () => {
    const p = new MebiusPlayer(sig(), {}, [{ kind: "wide", path: "/d/wide/s1" }]);
    const changes: QualityChange[] = [];
    const lists: unknown[] = [];
    p.on("quality-changed", (c) => changes.push(c));
    p.on("qualities-changed", (l) => lists.push(l));
    p.setMaxQuality(480);
    await p.setAllowedQualities(["480p"]);
    await p.play("s1", asVideo(el()));
    await p.setQuality("auto");
    await p.setAllowedQualities(null);
    const hls = FakeHls.instances[0]!;
    expect(new URL(hls.sources[0]!).search).toBe("?token=tok");
    expect(hls.writes).toEqual([]);
    expect(p.qualities).toEqual([]);
    expect(changes).toEqual([]);
    expect(lists).toEqual([[]]); // the one per-route announcement it always made
    await expect(p.setQuality("720p")).rejects.toThrow();
    await p.stop();
  });
});

describe("qualities mapping", () => {
  it("passes renditions from the delivery to fast and wide routes, sharing one prefs object", () => {
    const shared = prefs({ allowed: ["720p", "480p"] });
    const [fast, wide] = createViewCandidates(
      "auto",
      sig(),
      [
        { kind: "fast", path: "/d/fast/s1", renditions: LADDER },
        { kind: "wide", path: "/d/wide/s1", renditions: WIDE_LADDER },
      ],
      undefined,
      shared,
    );
    expect(fast!.qualities!().map((q) => q.id)).toEqual(["720p", "480p"]);
    expect(wide!.qualities!().map((q) => q.id)).toEqual(["720p", "480p"]);
    shared.allowed = null;
    expect(fast!.qualities!().map((q) => q.id)).toEqual(["1080p", "720p", "480p"]);
    // The path is an internal detail and never reaches the public shape.
    expect(fast!.qualities!()[0]).toEqual({ id: "1080p", label: "1080p", height: 1080, bitrateKbps: 5000 });
  });

  it("an allowed set that matches nothing on the ladder means all", () => {
    const t = new FlvViewTransport(sig(), "/d/fast/s1", undefined, LADDER, prefs({ allowed: ["4k"] }));
    expect(t.qualities().map((q) => q.id)).toEqual(["1080p", "720p", "480p"]);
  });
});

describe("HLS route (hls.js)", () => {
  async function started(q = prefs()) {
    const t = new HlsViewTransport(sig(), "/d/wide/s1", undefined, WIDE_LADDER, q);
    const changes: QualityChange[] = [];
    t.onQualityChanged((c) => changes.push(c));
    await t.start("s1", asVideo(el()));
    const hls = FakeHls.instances[0]!;
    hls.parse();
    return { t, hls, changes, q };
  }

  it("a pick uses nextLevel (no flush); auto hands back with loadLevel, never currentLevel", async () => {
    const { t, hls, changes, q } = await started();
    expect(t.qualities().map((x) => x.id)).toEqual(["1080p", "720p", "480p"]);
    hls.writes.length = 0;

    q.selected = "720p";
    await t.applyQuality();
    expect(hls.writes).toEqual([["nextLevel", 1]]); // levels ascending: 480, 720, 1080
    hls.switched(1);
    expect(changes.at(-1)).toEqual({ id: "720p", auto: false });

    q.selected = "auto";
    await t.applyQuality();
    expect(hls.writes).toEqual([
      ["nextLevel", 1],
      ["loadLevel", -1],
    ]);
    expect(changes.at(-1)).toEqual({ id: "720p", auto: true });
    expect(hls.writes.some(([k]) => k === "currentLevel")).toBe(false);
    expect(FakeHls.instances).toHaveLength(1); // never torn down to switch
  });

  it("auto while already auto writes nothing", async () => {
    const { t, hls } = await started();
    hls.writes.length = 0;
    await t.applyQuality();
    expect(hls.writes).toEqual([]);
  });

  it("caps auto at the highest level within maxQuality, also before the master is parsed", async () => {
    const { t, hls, q } = await started(prefs({ maxHeight: 480 }));
    expect(hls.autoLevelCapping).toBe(0);
    q.maxHeight = 720;
    await t.applyQuality();
    expect(hls.autoLevelCapping).toBe(1);
    q.maxHeight = 240; // below the ladder: the lowest rung, not "uncapped"
    await t.applyQuality();
    expect(hls.autoLevelCapping).toBe(0);
    q.maxHeight = Infinity;
    await t.applyQuality();
    expect(hls.autoLevelCapping).toBe(-1);
  });

  it("opens the master with q=<allowed ids> and reloads it only when the set changes", async () => {
    const q = prefs({ allowed: ["540p", "480p"] });
    const t = new HlsViewTransport(sig(), "/d/wide/s1", undefined, WIDE_LADDER, q);
    await t.start("s1", asVideo(el()));
    const hls = FakeHls.instances[0]!;
    const first = new URL(hls.sources[0]!);
    expect(first.searchParams.get("token")).toBe("tok");
    expect(first.searchParams.get("q")).toBe("480p"); // 540p is not on this ladder
    hls.parse([480]);
    expect(t.qualities().map((x) => x.id)).toEqual(["480p"]);

    await t.applyQuality();
    expect(hls.sources).toHaveLength(1);

    q.allowed = ["720p", "480p"];
    await t.applyQuality();
    expect(hls.sources).toHaveLength(2);
    expect(new URL(hls.sources[1]!).searchParams.get("q")).toBe("720p,480p");

    q.allowed = null;
    await t.applyQuality();
    expect(new URL(hls.sources[2]!).searchParams.has("q")).toBe(false);
    expect(FakeHls.instances).toHaveLength(1);
  });

  it("a pinned rung answering 404 falls back to auto instead of failing the route", async () => {
    const buffering = vi.fn();
    const { t, hls, changes, q } = await started(prefs({ selected: "1080p" }));
    t.onBuffering(buffering);
    expect(hls.writes.at(-1)).toEqual(["loadLevel", 2]);
    hls.handlers.get("e")!(undefined, { fatal: true, response: { code: 404 } });
    expect(q.selected).toBe("auto");
    expect(hls.writes.at(-1)).toEqual(["loadLevel", -1]);
    expect(changes.at(-1)!.auto).toBe(true);
    expect(buffering).not.toHaveBeenCalled();
  });

  it("an unmatched pick reports auto, not a pin that is not happening", async () => {
    const { t } = await started(prefs({ selected: "720p" }));
    const hls = FakeHls.instances[0]!;
    hls.parse([480, 1080]); // this master lacks 720p
    expect(t.currentQuality().auto).toBe(true);
  });

  it("Safari native: q on the master, a pick opens the rung, a failing pick returns to the master", async () => {
    FakeHls.supported = false;
    const q = prefs({ allowed: ["720p", "480p"] });
    const t = new HlsViewTransport(sig(), "/d/wide/s1", undefined, WIDE_LADDER, q);
    const v = el();
    await t.start("s1", asVideo(v));
    expect(pathOf(v.src)).toBe("/d/wide/s1");
    expect(new URL(v.src).searchParams.get("q")).toBe("720p,480p");

    q.selected = "480p";
    await t.applyQuality();
    expect(pathOf(v.src)).toBe("/d/wide/s1/480p");

    v.dispatch("error");
    await tick();
    expect(q.selected).toBe("auto");
    expect(pathOf(v.src)).toBe("/d/wide/s1");
  });
});

describe("FLV route (flv.js)", () => {
  async function started(q = prefs()) {
    const t = new FlvViewTransport(sig(), "/d/fast/s1", undefined, LADDER, q);
    const changes: QualityChange[] = [];
    t.onQualityChanged((c) => changes.push(c));
    const v = el();
    await t.start("s1", asVideo(v));
    v.dispatch("playing");
    return { t, v, changes, q };
  }

  it("auto opens the highest allowed rung within the cap", async () => {
    await started(prefs({ maxHeight: 1000 }));
    await started(prefs({ allowed: ["720p", "480p"] }));
    await started(prefs({ allowed: ["720p", "480p"], maxHeight: 600 }));
    expect(opened()).toEqual(["/d/fast/s1/720p", "/d/fast/s1/720p", "/d/fast/s1/480p"]);
  });

  it("a pick made while flv.js is still loading is the one that opens", async () => {
    const q = prefs();
    const t = new FlvViewTransport(sig(), "/d/fast/s1", undefined, LADDER, q);
    const starting = t.start("s1", asVideo(el()));
    q.selected = "480p"; // lands before the library import resolves
    await t.applyQuality(); // nothing to reopen yet: must not be lost
    await starting;
    expect(opened()).toEqual(["/d/fast/s1/480p"]);
  });

  it("the audio-less retry reopens the CURRENT rung, not the one start() began with", async () => {
    vi.useFakeTimers();
    const q = prefs();
    const t = new FlvViewTransport(sig(), "/d/fast/s1", undefined, LADDER, q);
    const v = el();
    v.currentTime = 0;
    v.buffered = { length: 1, end: () => 1 }; // data, but a clock that will not move
    const starting = t.start("s1", asVideo(v));
    await vi.dynamicImportSettled();
    expect(opened()).toEqual(["/d/fast/s1/1080p"]);
    q.selected = "480p";
    await t.applyQuality();
    await vi.advanceTimersByTimeAsync(2500);
    await starting;
    expect(flvOpened.at(-1)).toMatchObject({ hasAudio: false });
    expect(pathOf(flvOpened.at(-1)!.url)).toBe("/d/fast/s1/480p");
  });

  it("a manual pick reopens on that rung's path with the same token, keeping mute and volume", async () => {
    const { t, v, changes, q } = await started();
    v.muted = true;
    v.volume = 0.4;
    q.selected = "480p";
    await t.applyQuality();
    expect(opened()).toEqual(["/d/fast/s1/1080p", "/d/fast/s1/480p"]);
    expect(new URL(flvOpened[1]!.url).searchParams.get("token")).toBe("tok");
    expect(v.muted).toBe(true);
    expect(v.volume).toBe(0.4);
    expect(changes.at(-1)).toEqual({ id: "480p", auto: false });
  });

  it("a pick overrides the cap", async () => {
    const { t, q } = await started(prefs({ maxHeight: 480 }));
    q.selected = "1080p";
    await t.applyQuality();
    expect(opened().at(-1)).toBe("/d/fast/s1/1080p");
  });

  it("a reopen the autoplay policy had to mute updates mutedByPolicy", async () => {
    const { t, v, q } = await started();
    expect(t.mutedByPolicy).toBe(false);
    v.blockSound = true;
    q.selected = "720p";
    await t.applyQuality();
    expect(t.mutedByPolicy).toBe(true);
  });

  it("auto steps down one rung after two stalls within the window, and not on one", async () => {
    const now = vi.spyOn(Date, "now");
    const { v, changes } = await started();
    const stall = (atMs: number) => {
      now.mockReturnValue(atMs);
      v.dispatch("waiting");
      v.dispatch("waiting"); // flv.js repeats it inside one stall: still one
      v.dispatch("playing");
    };
    stall(10_000);
    stall(35_000); // outside the 20s window of the first: no step
    expect(flvOpened).toHaveLength(1);
    stall(40_000);
    expect(opened().at(-1)).toBe("/d/fast/s1/720p");
    expect(changes.at(-1)).toEqual({ id: "720p", auto: true });
  });

  it("steps down only within the allowed rungs, stopping at the lowest allowed", async () => {
    const now = vi.spyOn(Date, "now");
    const { v } = await started(prefs({ allowed: ["1080p", "720p"] }));
    for (let i = 1; i <= 6; i++) {
      now.mockReturnValue(i * 10_000);
      v.dispatch("waiting");
      v.dispatch("playing");
    }
    expect(opened()).toEqual(["/d/fast/s1/1080p", "/d/fast/s1/720p"]);
  });

  it("ignores a stall caused by its own live-edge seek, or while seeking", async () => {
    const now = vi.spyOn(Date, "now");
    const { v } = await started();
    const stall = (atMs: number) => {
      now.mockReturnValue(atMs);
      v.dispatch("waiting");
      v.dispatch("playing");
    };
    stall(10_000); // one real stall
    v.seeking = true;
    stall(11_000);
    v.seeking = false;
    // syncLiveEdge jumps: far behind the newest data.
    now.mockReturnValue(12_000);
    v.currentTime = 1;
    v.buffered = { length: 1, end: () => 30 };
    v.dispatch("timeupdate");
    stall(12_500); // the jump refilling
    expect(flvOpened).toHaveLength(1);
    stall(15_000); // a second REAL stall in the window
    expect(flvOpened).toHaveLength(2);
  });

  it("does not step down a manual pick", async () => {
    const { t, v, q } = await started();
    q.selected = "1080p";
    await t.applyQuality(); // already open: no reopen
    expect(flvOpened).toHaveLength(1);
    const now = vi.spyOn(Date, "now");
    for (let i = 1; i <= 4; i++) {
      now.mockReturnValue(i * 1000);
      v.dispatch("waiting");
      v.dispatch("playing");
    }
    expect(flvOpened).toHaveLength(1);
  });

  it("a pinned rung answering 404 falls back to auto instead of failing the route", async () => {
    const buffering = vi.fn();
    const { t, changes, q } = await started(prefs({ selected: "1080p", maxHeight: 720 }));
    t.onBuffering(buffering);
    flvOpened[0]!.onError!("NetworkError", "HttpStatusCodeInvalid", { code: 404 });
    await tick();
    expect(q.selected).toBe("auto");
    expect(opened().at(-1)).toBe("/d/fast/s1/720p"); // auto, within the cap
    expect(changes.at(-1)).toEqual({ id: "720p", auto: true });
    expect(buffering).not.toHaveBeenCalled();
  });
});

describe("player quality API", () => {
  const fastPlayer = () =>
    new MebiusPlayer(sig(), {}, [{ kind: "fast", path: "/d/fast/s1", renditions: LADDER }]);

  it("exposes the ladder and announces what is on screen", async () => {
    const p = fastPlayer();
    const changes: QualityChange[] = [];
    p.on("quality-changed", (c) => changes.push(c));
    await p.play("s1", asVideo(el()));
    expect(p.qualities.map((q) => q.id)).toEqual(["1080p", "720p", "480p"]);
    expect(changes).toEqual([{ id: "1080p", auto: true }]);
    await p.stop();
  });

  it("keeps a pick made while the route is being reopened, and opens on it", async () => {
    const p = fastPlayer();
    const v = asVideo(el());
    await p.play("s1", v);
    const internals = p as unknown as {
      releaseRoute(): Promise<void>;
      openRoute(id: string, v: HTMLVideoElement): Promise<unknown>;
    };
    await internals.releaseRoute(); // what recovery does before reopening
    await p.setQuality("480p");
    await internals.openRoute("s1", v);
    expect(opened().at(-1)).toBe("/d/fast/s1/480p");
    await p.stop();
  });

  it("validates setMaxQuality", () => {
    const p = fastPlayer();
    const max = () => (p as unknown as { prefs: QualityPrefs }).prefs.maxHeight;
    for (const none of [0, null, undefined, Infinity]) {
      p.setMaxQuality(720);
      p.setMaxQuality(none);
      expect(max()).toBe(Infinity);
    }
    expect(() => p.setMaxQuality(-1)).toThrow();
    expect(() => p.setMaxQuality(NaN)).toThrow();
    expect(() => p.setMaxQuality("720" as unknown as number)).toThrow();
  });

  it("setAllowedQualities filters the list, announces only real changes, and rejects other ids", async () => {
    const p = fastPlayer();
    const lists: string[][] = [];
    p.on("qualities-changed", (l) => lists.push(l.map((q) => q.id)));
    await p.play("s1", asVideo(el()));

    await p.setAllowedQualities(["540p", "480p"]);
    expect(p.qualities.map((q) => q.id)).toEqual(["480p"]);
    expect(opened().at(-1)).toBe("/d/fast/s1/480p"); // auto left the disallowed rung
    await p.setAllowedQualities(["480p"]); // same list: no announcement
    await expect(p.setQuality("1080p")).rejects.toThrow(/1080p/);

    await p.setAllowedQualities(["4k"]); // matches nothing: all
    await p.setAllowedQualities([]);
    expect(lists).toEqual([
      ["1080p", "720p", "480p"],
      ["480p"],
      ["1080p", "720p", "480p"],
    ]);
    await p.stop();
  });

  it("an allowed set made before play() holds from the first frame and survives a reopen", async () => {
    const p = fastPlayer();
    await p.setAllowedQualities(["720p", "480p"]);
    const v = asVideo(el());
    await p.play("s1", v);
    expect(opened()).toEqual(["/d/fast/s1/720p"]);
    await p.stop();
    await p.play("s1", v);
    expect(opened().at(-1)).toBe("/d/fast/s1/720p");
    expect(p.qualities.map((q) => q.id)).toEqual(["720p", "480p"]);
    await p.stop();
  });

  it("a pick that is no longer allowed goes back to auto", async () => {
    const p = fastPlayer();
    const changes: QualityChange[] = [];
    p.on("quality-changed", (c) => changes.push(c));
    await p.play("s1", asVideo(el()));
    await p.setQuality("1080p");
    await p.setAllowedQualities(["720p", "480p"]);
    expect(changes.at(-1)).toEqual({ id: "720p", auto: true });
    await p.stop();
  });
});
