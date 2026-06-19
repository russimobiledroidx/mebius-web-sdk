import { mebiusError } from "./errors.js";
import { TypedEmitter, type BroadcasterEventMap } from "./events.js";
import { resolveVideoElement } from "./internal/view-target.js";
import type { SignalingClient } from "./internal/signaling.js";
import { createPublishTransport, type PublishTransport } from "./internal/transport.js";
import type { BroadcasterOptions, MediaConstraint, ViewTarget } from "./types.js";

const STATS_INTERVAL_MS = 2000;

/**
 * Publishes the local camera/microphone to a Mebius stream.
 *
 * Create one with {@link MebiusClient.createBroadcaster}, then
 * {@link MebiusBroadcaster.start | start} it with a stream id.
 */
export class MebiusBroadcaster extends TypedEmitter<BroadcasterEventMap> {
  private readonly transport: PublishTransport;
  private stream: MediaStream | null = null;
  private facingMode: "user" | "environment" = "user";
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  /** @internal */
  constructor(
    signaling: SignalingClient,
    private readonly options: BroadcasterOptions,
  ) {
    super();
    this.transport = createPublishTransport(signaling);
  }

  /** Begin broadcasting under the given stream id. */
  async start(streamId: string): Promise<void> {
    if (this.started) return;
    this.stream = await this.capture();
    await this.transport.start(streamId, this.stream);
    this.started = true;
    this.startStats();
    this.emit("started", { streamId });
  }

  /** Stop broadcasting and release the camera/microphone. */
  async stop(): Promise<void> {
    this.stopStats();
    await this.transport.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.started = false;
    this.emit("stopped", undefined);
  }

  /** Flip between front and back camera (where available). */
  async switchCamera(): Promise<void> {
    if (!this.stream) return;
    this.facingMode = this.facingMode === "user" ? "environment" : "user";
    const next = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: this.facingMode },
      audio: false,
    });
    const newTrack = next.getVideoTracks()[0] ?? null;
    const oldTrack = this.stream.getVideoTracks()[0];
    if (oldTrack) {
      this.stream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    if (newTrack) this.stream.addTrack(newTrack);
    await this.transport.replaceVideoTrack(newTrack);
  }

  /** Mute or unmute the outgoing microphone. */
  setMicEnabled(enabled: boolean): void {
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }

  /** Enable or disable the outgoing camera. */
  setCameraEnabled(enabled: boolean): void {
    this.stream?.getVideoTracks().forEach((t) => (t.enabled = enabled));
  }

  /**
   * Web convenience: render the local camera preview into a `<video>` element.
   * This is the web analog of the mobile preview view; it does not affect what
   * is broadcast.
   */
  attachPreview(target: ViewTarget): void {
    if (!this.stream) return;
    const video = resolveVideoElement(target);
    video.srcObject = this.stream;
    video.muted = true;
    void video.play().catch(() => undefined);
  }

  private async capture(): Promise<MediaStream> {
    const video = normalize(this.options.video, true);
    const audio = normalize(this.options.audio, true);
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (cause) {
      throw mebiusError("PERMISSION_DENIED", undefined, cause);
    }
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

function normalize(c: MediaConstraint | undefined, fallback: boolean): boolean | MediaTrackConstraints {
  if (c === undefined) return fallback;
  return c;
}
