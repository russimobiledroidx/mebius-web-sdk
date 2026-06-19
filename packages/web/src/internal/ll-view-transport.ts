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

export class WhepViewTransport implements ViewTransport {
  private pc: RTCPeerConnection | null = null;
  private resourceUrl: string | null = null;
  private endedCb: (() => void) | null = null;
  private bufferingCb: (() => void) | null = null;

  constructor(private readonly signaling: SignalingClient) {}

  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }

  onBuffering(cb: () => void): void {
    this.bufferingCb = cb;
  }

  async start(streamId: string, video: HTMLVideoElement): Promise<void> {
    const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);
    this.pc = pc;
    const remote = new MediaStream();

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      remote.addTrack(ev.track);
      video.srcObject = remote;
      void video.play().catch(() => {
        /* autoplay may require a user gesture; left to the app */
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

    const { answerSdp, resourceUrl } = await this.signaling.exchangeSdp(
      "whep",
      streamId,
      localSdp,
    );
    this.resourceUrl = resourceUrl;
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  async stop(): Promise<void> {
    await this.signaling.deleteResource(this.resourceUrl);
    this.resourceUrl = null;
    this.pc?.close();
    this.pc = null;
  }

  async getStats(): Promise<PlaybackStats | null> {
    if (!this.pc) return null;
    const report = await this.pc.getStats();
    let bitrateKbps = 0;
    let framesPerSecond = 0;
    let latencyMs: number | undefined;
    report.forEach((stat) => {
      if (stat.type === "inbound-rtp") {
        if (typeof stat.framesPerSecond === "number") framesPerSecond = stat.framesPerSecond;
        if (typeof stat.jitter === "number") latencyMs = Math.round(stat.jitter * 1000);
      }
      if (stat.type === "candidate-pair" && stat.state === "succeeded") {
        if (typeof stat.availableIncomingBitrate === "number") {
          bitrateKbps = Math.round(stat.availableIncomingBitrate / 1000);
        }
      }
    });
    return { bitrateKbps, framesPerSecond, latencyMs };
  }
}
