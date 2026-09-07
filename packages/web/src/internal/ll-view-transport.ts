/**
 * INTERNAL — low-latency view transport (WHEP over the gateway).
 *
 * Pulls a remote stream from the Mebius gateway via a standard WHEP exchange
 * and renders it into a video element. Hidden from the public API.
 */
import type { PlaybackStats } from "../types.js";
import { mebiusError } from "../errors.js";
import type { SignalingClient } from "./signaling.js";
import type { ViewTransport } from "./transport.js";
import { DEFAULT_RTC_CONFIG, waitForIceGathering } from "./webrtc-util.js";
import { playWithAutoplayFallback, resetVideoElement } from "./autoplay.js";

/**
 * Default delay held ahead of the picture on the real-time route, in ms.
 *
 * Not zero, deliberately. Browsers left to themselves shrink this buffer to
 * almost nothing on a fast path, which sounds ideal and is not: with no cushion,
 * a single re-sent packet arrives too late to use, the decoder cannot continue,
 * and the picture freezes until the next complete frame — usually one to two
 * seconds away. So the smallest buffer produces the LONGEST stalls. 300ms covers
 * several round trips on mobile data, stays well under the threshold where
 * conversation feels laggy, and turns those freezes into nothing at all.
 */
export const DEFAULT_REALTIME_TARGET_MS = 300;

/**
 * Ask the browser to hold `targetMs` of video before showing it.
 *
 * Two APIs for one thing: `jitterBufferTarget` is the current standard,
 * `playoutDelayHint` the older name still shipping in browsers that predate it.
 * Both are set when present, and neither is required — a browser with neither
 * simply keeps its own default, which is the behaviour this route always had.
 *
 * Exported for its test only.
 */
export function holdBuffer(receiver: RTCRtpReceiver, targetMs: number): void {
  const r = receiver as RTCRtpReceiver & {
    jitterBufferTarget?: number | null;
    playoutDelayHint?: number | null;
  };
  try {
    if ("jitterBufferTarget" in r) r.jitterBufferTarget = targetMs;
    if ("playoutDelayHint" in r) r.playoutDelayHint = targetMs / 1000;
  } catch {
    // A browser that exposes the property but rejects the value keeps its own.
  }
}

/**
 * Cumulative counters from the previous reading.
 *
 * Every number the connection reports is a running total since the session
 * began. Reporting those raw would make a session look worse the longer it ran
 * and would average away the very spikes worth seeing, so each sample is the
 * difference between two readings — what happened in the last couple of seconds
 * and nothing else.
 */
interface StatsCursor {
  atMs: number;
  freezeS: number;
  packetsLost: number;
  packetsReceived: number;
  bytesReceived: number;
  bufferDelayS: number;
  bufferEmitted: number;
}

export class WhepViewTransport implements ViewTransport {
  readonly kind = "whep" as const;

  private cursor: StatsCursor | null = null;

  private pc: RTCPeerConnection | null = null;
  private resourceUrl: string | null = null;
  private endedCb: (() => void) | null = null;
  private bufferingCb: (() => void) | null = null;

  /** Element this route attached a MediaStream to, so stop() can release it. */
  private video: HTMLVideoElement | null = null;

  constructor(
    private readonly signaling: SignalingClient,
    private readonly targetLatencyMs: number = DEFAULT_REALTIME_TARGET_MS,
  ) {}

  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }

  onBuffering(cb: () => void): void {
    this.bufferingCb = cb;
  }

  async start(streamId: string, video: HTMLVideoElement): Promise<void> {
    this.video = video;
    const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);
    this.pc = pc;
    const remote = new MediaStream();

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      // Both tracks, and with the same target: audio and video are played in
      // step, so a buffer applied to one alone would just be overridden by the
      // other and the picture would keep stalling.
      holdBuffer(ev.receiver, this.targetLatencyMs);
      remote.addTrack(ev.track);
      video.srcObject = remote;
      // Muted retry rather than giving up: "left to the app" meant a viewer saw a
      // black rectangle and the app was told nothing.
      void playWithAutoplayFallback(video)
        .then((o) => {
          this.mutedByPolicy = o.mutedByPolicy;
        })
        .catch(() => {
          /* a genuine failure here surfaces as no first frame, which the player's
             route watchdog already handles */
        });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        this.bufferingCb?.();
      }
      if (pc.connectionState === "closed") this.endedCb?.();
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) throw mebiusError("CONNECTION_FAILED", "Failed to create a local session.");

    const { answer, resourceUrl } = await this.signaling.exchangeSession(
      "view",
      streamId,
      localSdp,
    );
    this.resourceUrl = resourceUrl;
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  }

  async stop(): Promise<void> {
    // Drop the counters with the connection. A later session's first reading
    // would otherwise be differenced against a dead one and report its whole
    // history as a single enormous spike.
    this.cursor = null;
    await this.signaling.deleteResource(this.resourceUrl);
    this.resourceUrl = null;
    this.pc?.close();
    this.pc = null;
    // Release the element's MediaStream. While srcObject is set the element
    // ignores `src`, so leaving it behind stops the next route (HLS/FLV) from
    // ever rendering — a black picture with a perfectly healthy playlist.
    if (this.video) resetVideoElement(this.video);
    this.video = null;
  }

  /** True when playback only started because the element had to be muted. */
  mutedByPolicy = false;

  /**
   * Read what the connection actually did since the last reading.
   *
   * This route needs to measure its own freezes, because nothing else can. A
   * frozen real-time picture still reports a healthy connection and raises no
   * event on the video element — so from the outside the session looks flawless
   * while the viewer stares at a still frame. Every freeze on this route used to
   * be recorded as zero, which is why the problem could be felt and never seen.
   */
  async getStats(): Promise<PlaybackStats | null> {
    if (!this.pc) return null;
    const report = await this.pc.getStats();

    let framesPerSecond: number | undefined;
    let freezeS = 0;
    let packetsLost = 0;
    let packetsReceived = 0;
    let bytesReceived = 0;
    let bufferDelayS = 0;
    let bufferEmitted = 0;
    let rttMs: number | undefined;

    report.forEach((stat) => {
      // Video only. Audio rides the same connection but never freezes the
      // picture, and folding its packet counts in would dilute the loss figure
      // for the track this route is judged on.
      if (stat.type === "inbound-rtp" && stat.kind === "video") {
        const v = stat as RTCInboundRtpStreamStats & {
          totalFreezesDuration?: number;
          jitterBufferDelay?: number;
          jitterBufferEmittedCount?: number;
          framesPerSecond?: number;
        };
        if (typeof v.framesPerSecond === "number") framesPerSecond = v.framesPerSecond;
        if (typeof v.totalFreezesDuration === "number") freezeS = v.totalFreezesDuration;
        if (typeof v.packetsLost === "number") packetsLost = v.packetsLost;
        if (typeof v.packetsReceived === "number") packetsReceived = v.packetsReceived;
        if (typeof v.bytesReceived === "number") bytesReceived = v.bytesReceived;
        if (typeof v.jitterBufferDelay === "number") bufferDelayS = v.jitterBufferDelay;
        if (typeof v.jitterBufferEmittedCount === "number") bufferEmitted = v.jitterBufferEmittedCount;
      }
      if (stat.type === "candidate-pair" && stat.state === "succeeded") {
        const p = stat as RTCIceCandidatePairStats;
        if (typeof p.currentRoundTripTime === "number") rttMs = Math.round(p.currentRoundTripTime * 1000);
      }
    });

    const atMs = Date.now();
    const previous = this.cursor;
    this.cursor = { atMs, freezeS, packetsLost, packetsReceived, bytesReceived, bufferDelayS, bufferEmitted };
    // First reading of a session has nothing to difference against. Reporting a
    // confident zero there would claim a measurement nobody made.
    if (!previous) return { framesPerSecond, rttMs };

    const elapsedS = Math.max(0.001, (atMs - previous.atMs) / 1000);
    const deltaLost = Math.max(0, packetsLost - previous.packetsLost);
    const deltaReceived = Math.max(0, packetsReceived - previous.packetsReceived);
    const deltaEmitted = bufferEmitted - previous.bufferEmitted;

    // How long each frame waited before being shown — the delay the viewer is
    // actually living with, rather than the one that was configured. Plus half a
    // round trip for the network leg it cannot see.
    const heldMs =
      deltaEmitted > 0
        ? ((bufferDelayS - previous.bufferDelayS) / deltaEmitted) * 1000
        : undefined;

    return {
      bitrateKbps: Math.round(((bytesReceived - previous.bytesReceived) * 8) / elapsedS / 1000),
      framesPerSecond,
      latencyMs:
        heldMs === undefined ? undefined : Math.round(heldMs + (rttMs !== undefined ? rttMs / 2 : 0)),
      rttMs,
      packetLossPct:
        deltaLost + deltaReceived > 0
          ? Number(((deltaLost / (deltaLost + deltaReceived)) * 100).toFixed(2))
          : 0,
      freezeMs: Math.max(0, Math.round((freezeS - previous.freezeS) * 1000)),
    };
  }
}
