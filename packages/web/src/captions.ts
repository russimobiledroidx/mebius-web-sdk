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
  translations?: Record<string, string>;
  machineGenerated?: boolean;
}

/** How often the draw loop checks the playhead against pending segments. */
const TICK_MS = 100;
/**
 * A late joiner's snapshot only reaches back this far — showing captions for
 * audio the viewer never heard reads as spam, not context.
 */
const STALE_MS = 5000;

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
  private readonly shown = new Set<string>();

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
    const url = this.signaling.captionsUrl(streamId, this.opts.lang);
    const es = new EventSource(url);
    es.onmessage = (ev) => this.onFrame(ev);
    es.onerror = () => this.emit("error", undefined);
    this.es = es;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Close the connection and drop all buffered segments. */
  stop(): void {
    this.es?.close();
    this.es = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pending.clear();
    this.shown.clear();
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
    this.pending.set(frame.segmentId, frame);
  }

  private tick(): void {
    const now = this.player.currentEpochMs();
    if (now == null) return;
    for (const [id, frame] of this.pending) {
      const due = frame.epochMs ?? 0;
      if (due > now) continue; // not yet — leave it queued
      if (due < now - STALE_MS) {
        this.pending.delete(id);
        if (this.shown.delete(id)) this.emit("cleared", { segmentId: id });
        continue;
      }
      this.shown.add(id);
      this.emit("segment", toSegment(id, frame, this.opts.lang));
      if (frame.state === "final") this.pending.delete(id);
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
    translation: frame.translations?.[lang],
    machineGenerated: true,
  };
}
