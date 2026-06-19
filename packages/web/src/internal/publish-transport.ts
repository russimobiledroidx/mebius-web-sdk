/**
 * INTERNAL — publish transport (WHIP over the gateway).
 *
 * Sends a locally-captured MediaStream to the Mebius gateway via a standard
 * WHIP offer/answer exchange. Hidden from the public API.
 */
import type { BroadcastStats } from "../types.js";
import { mebiusError } from "../errors.js";
import type { SignalingClient } from "./signaling.js";
import type { PublishTransport } from "./transport.js";
import { DEFAULT_RTC_CONFIG, waitForIceGathering } from "./webrtc-util.js";

export class WhipPublishTransport implements PublishTransport {
  private pc: RTCPeerConnection | null = null;
  private resourceUrl: string | null = null;

  constructor(private readonly signaling: SignalingClient) {}

  async start(streamId: string, stream: MediaStream): Promise<void> {
    const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);
    this.pc = pc;

    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) throw mebiusError("CONNECTION_FAILED", "Failed to create a local session.");

    const { answerSdp, resourceUrl } = await this.signaling.exchangeSdp(
      "whip",
      streamId,
      localSdp,
    );
    this.resourceUrl = resourceUrl;
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(track);
  }

  async stop(): Promise<void> {
    await this.signaling.deleteResource(this.resourceUrl);
    this.resourceUrl = null;
    this.pc?.getSenders().forEach((s) => s.track?.stop());
    this.pc?.close();
    this.pc = null;
  }

  async getStats(): Promise<BroadcastStats | null> {
    if (!this.pc) return null;
    const report = await this.pc.getStats();
    let bitrateKbps = 0;
    let framesPerSecond = 0;
    let rttMs: number | undefined;
    report.forEach((stat) => {
      if (stat.type === "outbound-rtp" && !stat.isRemote) {
        if (typeof stat.framesPerSecond === "number") framesPerSecond = stat.framesPerSecond;
      }
      if (stat.type === "candidate-pair" && stat.state === "succeeded") {
        if (typeof stat.availableOutgoingBitrate === "number") {
          bitrateKbps = Math.round(stat.availableOutgoingBitrate / 1000);
        }
        if (typeof stat.currentRoundTripTime === "number") {
          rttMs = Math.round(stat.currentRoundTripTime * 1000);
        }
      }
    });
    return { bitrateKbps, framesPerSecond, rttMs };
  }
}
