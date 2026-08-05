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

/**
 * Offer H264 ahead of everything else for the outgoing video track.
 *
 * Chrome negotiates VP8 by default, and VP8 is a dead end for every viewer who
 * is not on WebRTC: the server's HLS/FLV muxers cannot carry it, so they drop
 * the video track and publish an audio-only stream ("skipping track (VP8)").
 * The broadcast looks perfect to the publisher and has no picture for anyone
 * watching over HLS, FLV, or the CDN.
 *
 * H264 is what every one of those paths speaks, and negotiating it here means
 * the server never has to transcode — which would cost far more latency than
 * anything else in this SDK.
 *
 * Best-effort by design: `setCodecPreferences` is unavailable on older Safari,
 * and a browser without an H264 encoder has nothing to reorder. Both cases fall
 * through to the default negotiation rather than failing the broadcast.
 */
function preferH264(pc: RTCPeerConnection): void {
  const caps = RTCRtpSender.getCapabilities?.("video");
  if (!caps?.codecs) return;
  const h264 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === "video/h264");
  if (h264.length === 0) return;
  const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== "video/h264");
  for (const tr of pc.getTransceivers()) {
    if (tr.sender.track?.kind !== "video") continue;
    try {
      tr.setCodecPreferences?.([...h264, ...rest]);
    } catch {
      // A browser that rejects the list negotiates its own way; still better
      // than no video for CDN viewers on the browsers that accept it.
    }
  }
}

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
    preferH264(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) throw mebiusError("CONNECTION_FAILED", "Failed to create a local session.");

    const { answer, resourceUrl } = await this.signaling.exchangeSession(
      "publish",
      streamId,
      localSdp,
    );
    this.resourceUrl = resourceUrl;
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
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
