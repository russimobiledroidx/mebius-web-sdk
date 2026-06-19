import { TypedEmitter, type PlayerEventMap } from "./events.js";
import { resolveVideoElement } from "./internal/view-target.js";
import type { SignalingClient } from "./internal/signaling.js";
import { createViewTransport, type ViewTransport } from "./internal/transport.js";
import type { PlayerOptions, ViewTarget } from "./types.js";

const STATS_INTERVAL_MS = 2000;

/**
 * Plays a Mebius stream into a `<video>` element.
 *
 * Create one with {@link MebiusClient.createPlayer}, choosing a playback
 * {@link PlaybackMode | mode}; Mebius selects the right delivery automatically.
 */
export class MebiusPlayer extends TypedEmitter<PlayerEventMap> {
  private readonly transport: ViewTransport;
  private video: HTMLVideoElement | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private playing = false;

  /** @internal */
  constructor(signaling: SignalingClient, options: PlayerOptions) {
    super();
    this.transport = createViewTransport(options.mode, signaling);
    this.transport.onEnded(() => {
      this.playing = false;
      this.stopStats();
      this.emit("ended", undefined);
    });
    this.transport.onBuffering(() => this.emit("buffering", undefined));
  }

  /** Start playing `streamId` into the given video element or selector. */
  async play(streamId: string, viewTarget: ViewTarget): Promise<void> {
    if (this.playing) return;
    this.video = resolveVideoElement(viewTarget);
    await this.transport.start(streamId, this.video);
    this.playing = true;
    this.startStats();
    this.emit("playing", { streamId });
  }

  /** Stop playback and detach from the video element. */
  async stop(): Promise<void> {
    this.stopStats();
    await this.transport.stop();
    this.video = null;
    this.playing = false;
  }

  /** Set output volume in the range 0..1. */
  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    if (this.video) this.video.volume = v;
  }

  private startStats(): void {
    this.statsTimer = setInterval(async () => {
      const stats = await this.transport.getStats();
      if (stats) this.emit("stats", stats);
    }, STATS_INTERVAL_MS);
  }

  private stopStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }
}
