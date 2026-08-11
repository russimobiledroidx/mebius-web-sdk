/**
 * Realtime captions — subscribes to the engine's caption SSE feed and emits
 * segments on the video's own timeline, not on arrival order.
 *
 * The engine (mebius-stream-engine, `internal/caption`) does the ASR/translate
 * work and starts sending segments the moment a sentence finishes — which is
 * BEFORE the viewer's player, sitting behind the live edge by however much its
 * transport buffers, has shown the matching frame. Rendering on arrival would
 * show the caption before the streamer says it. So every segment is buffered by
 * `epochMs` (when the audio was actually spoken, a wall clock) and released only
 * once {@link MebiusPlayer.currentEpochMs} reaches it. See
 * mebius-stream-engine/docs/INTEGRATION.md §6.
 */
import { TypedEmitter, type CaptionsEventMap } from "./events.js";
import type { SignalingClient } from "./internal/signaling.js";
import type { MebiusPlayer } from "./player.js";
import type { CaptionsOptions, CaptionSegment } from "./types.js";

/** Wire frame shape from the engine SSE feed (see docs/API.md §5.2). */
interface CaptionFrame {
  type: "caption" | "state";
  segmentId?: string;
  rev?: number;
  state?: string;
  epochMs?: number;
  durationMs?: number;
  text?: string;
  srcLang?: string;
  translations?: Record<string, string>;
  machineGenerated?: boolean;
  /** Set by this client on receipt; never sent by the engine. See tick(). */
  receivedAtMs?: number;
}

/** How often the draw loop checks the playhead against pending segments. */
const TICK_MS = 100;
/**
 * A late joiner's snapshot only reaches back this far — showing captions for
 * audio the viewer never heard reads as spam, not context.
 */
const STALE_MS = 5000;
/**
 * How long a segment may sit queued waiting to become due before it is shown
 * anyway. A segment whose `epochMs` never arrives at the playhead means the
 * playhead is wrong (a bad estimate, a transport clock that never advances),
 * not that the audio is in the future — so this bounds "wait for sync" and
 * keeps a clock problem from turning into permanent silence.
 */
const MAX_QUEUE_MS = 1500;
/**
 * How long the page may stay hidden before the feed is dropped.
 *
 * A caption session bills per second of broadcast audio and the engine only
 * stops one once nobody is subscribed — so a viewer who leaves a tab open in
 * the background keeps a session billing, up to its four-hour cap, while
 * reading nothing (captions are unreadable in a hidden tab by definition).
 *
 * Long enough that ordinary tab-switching does not churn the connection,
 * short enough that an abandoned tab costs ~2.5 minutes (this window, then
 * the engine's own ~90s idle stop) instead of hours.
 */
const HIDDEN_GRACE_MS = 60_000;

/**
 * Subscribes to one stream's caption feed. Create with
 * {@link MebiusClient.createCaptions}, `start()` it, and listen for `"segment"`
 * / `"cleared"`.
 *
 * Starting the caption SESSION (`captions/start`, which spends money) is a
 * separate, server-side call — this class only ever reads the feed a session
 * already produces. That split is deliberate: the control endpoint needs an API
 * key, which must never reach a browser.
 */
export class MebiusCaptions extends TypedEmitter<CaptionsEventMap> {
  private es: EventSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, CaptionFrame>();
  /**
   * segmentId -> the rev already handed to listeners. Not a Set: with interim
   * revisions on, a segment stays pending while it is being corrected, and a
   * plain "have I shown this id" check re-emits the same unchanged text on
   * every 100ms tick. Comparing revs emits exactly once per actual revision.
   */
  private readonly shown = new Map<string, number>();
  /** Kept so the feed can be reopened after a hidden-tab suspend. */
  private streamId: string | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private onVisibility: (() => void) | null = null;

  /** @internal */
  constructor(
    private readonly signaling: SignalingClient,
    private readonly player: MebiusPlayer,
    private readonly opts: CaptionsOptions,
  ) {
    super();
  }

  /** Open the SSE connection and begin emitting segments for `streamId`. */
  start(streamId: string): void {
    if (this.es) return;
    this.streamId = streamId;
    this.openFeed();
    this.watchVisibility();
  }

  /** Close the connection and drop all buffered segments. */
  stop(): void {
    this.streamId = null;
    if (this.onVisibility && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.onVisibility = null;
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    this.closeFeed();
    this.pending.clear();
    this.shown.clear();
  }

  private openFeed(): void {
    if (this.es || !this.streamId) return;
    const es = new EventSource(this.signaling.captionsUrl(this.streamId, this.opts.lang));
    es.onmessage = (ev) => this.onFrame(ev);
    es.onerror = () => this.emit("error", undefined);
    this.es = es;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private closeFeed(): void {
    this.es?.close();
    this.es = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Drop the feed while the page is hidden, restore it when it comes back.
   *
   * Nothing here is about rendering — a hidden tab shows no captions either
   * way. It is about not holding a subscriber open, since that subscriber is
   * what keeps a billed session alive on the engine.
   *
   * Buffered segments are deliberately kept across a suspend: they age out on
   * their own (STALE_MS) and clearing them would blank the screen on return
   * for no benefit.
   */
  private watchVisibility(): void {
    if (typeof document === "undefined") return;
    this.onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (this.hiddenTimer) return;
        this.hiddenTimer = setTimeout(() => {
          this.hiddenTimer = null;
          this.closeFeed();
        }, HIDDEN_GRACE_MS);
        return;
      }
      if (this.hiddenTimer) {
        clearTimeout(this.hiddenTimer);
        this.hiddenTimer = null;
      }
      this.openFeed();
    };
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private onFrame(ev: MessageEvent<string>): void {
    let frame: CaptionFrame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (frame.type !== "caption" || !frame.segmentId) return;
    // Sort by segmentId + rev, never by arrival: a revision replaces its
    // segment in place, and a reconnect can redeliver an older one.
    const prev = this.pending.get(frame.segmentId);
    if (prev && (frame.rev ?? 0) < (prev.rev ?? 0)) return;
    frame.receivedAtMs = Date.now();
    this.pending.set(frame.segmentId, frame);
  }

  private tick(): void {
    const now = this.player.currentEpochMs();
    for (const [id, frame] of this.pending) {
      const due = frame.epochMs ?? 0;
      const waitedMs = Date.now() - (frame.receivedAtMs ?? 0);

      // No playhead from the active transport (WHEP today, or HLS before its
      // first PROGRAM-DATE-TIME lands): render on arrival instead of waiting
      // for a clock that will never come. Captions may then run slightly ahead
      // of the picture, which the engine's design prefers to avoid — but the
      // alternative here is not "slightly early", it is a feature that is
      // permanently, silently blank, which is strictly worse.
      const dueNow = now == null ? true : due <= now;
      if (!dueNow) {
        // A segment that never becomes due is a broken clock, not a future
        // segment. Release it rather than queue it forever.
        if (waitedMs < MAX_QUEUE_MS) continue;
      }

      // Stale only counts from when WE received it, never from epoch-vs-
      // playhead: the playhead can be an estimate (see FlvViewTransport), and
      // measuring staleness against a guess silently deleted freshly-arrived
      // captions whenever the guess ran ahead of reality. Time spent on screen
      // is the thing being bounded, so time since arrival is what to measure.
      if (waitedMs > STALE_MS && this.shown.has(id)) {
        this.pending.delete(id);
        this.shown.delete(id);
        this.emit("cleared", { segmentId: id });
        continue;
      }

      const rev = frame.rev ?? 0;
      if (this.shown.get(id) === rev) continue;
      this.shown.set(id, rev);
      this.emit("segment", toSegment(id, frame, this.opts.lang));
    }
  }
}

function toSegment(segmentId: string, frame: CaptionFrame, lang: string): CaptionSegment {
  return {
    segmentId,
    rev: frame.rev ?? 0,
    state: frame.state === "final" ? "final" : "interim",
    epochMs: frame.epochMs ?? 0,
    durationMs: frame.durationMs ?? 0,
    text: frame.text ?? "",
    srcLang: frame.srcLang,
    translation: frame.translations?.[lang],
    machineGenerated: true,
  };
}
