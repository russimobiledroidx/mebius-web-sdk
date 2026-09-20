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

/**
 * Ceiling on what a publisher's video encoder may send, in kbps.
 *
 * 2500 matches what the studio's OBS encoder is configured to send, so a broadcast
 * costs the same whichever path it came from — a host in a browser and a host in
 * the studio bill identically.
 *
 * A ceiling, not a target: the encoder still spends less on still scenes. What it
 * removes is the open end, where a capable machine answered high-motion content
 * with whatever it could encode.
 *
 * Every Mebius SDK carries this same number. Changing it in one place without the
 * others makes the cost of a broadcast depend on the device that made it.
 */
export const DEFAULT_MAX_BITRATE_KBPS = 2500;

export class WhipPublishTransport implements PublishTransport {
  private pc: RTCPeerConnection | null = null;
  private resourceUrl: string | null = null;

  constructor(
    private readonly signaling: SignalingClient,
    private readonly maxBitrateKbps: number = DEFAULT_MAX_BITRATE_KBPS,
  ) {}

  /**
   * Caps the video encoder on the sender, which is the only place the ceiling is
   * real — see BroadcasterOptions.maxBitrateKbps.
   *
   * Best effort. A browser that refuses the parameters publishes uncapped rather
   * than failing to go live: an unbudgeted broadcast beats no broadcast, and the
   * stats report the truth either way.
   */
  private async applyBitrateCap(): Promise<void> {
    if (!this.maxBitrateKbps || this.maxBitrateKbps <= 0) return;
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      for (const encoding of params.encodings) {
        encoding.maxBitrate = this.maxBitrateKbps * 1000;
      }
      await sender.setParameters(params);
    } catch (cause) {
      console.warn("[mebius] could not cap the publish bitrate", cause);
    }
  }

  async start(streamId: string, stream: MediaStream): Promise<void> {
    const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);
    this.pc = pc;

    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
    preferH264(pc);
    await this.applyBitrateCap();

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

  /** Bytes sent and packet counters at the previous getStats() call. */
  private lastOutbound: { bytes: number; atMs: number } | null = null;

  /**
   * Live broadcast statistics.
   *
   * Two corrections over the obvious reading of RTCStats:
   *
   * `bitrateKbps` is the delta of `outbound-rtp.bytesSent`, not
   * `availableOutgoingBitrate`. The latter is the congestion controller's
   * ESTIMATE of headroom, so a broadcaster on a fast link reported several
   * megabits while actually sending a fraction of that — the dashboard's
   * "bitrate adherence" score was measuring the network, not the encoder.
   *
   * `packetLossPct` comes from the receiver's report (`remote-inbound-rtp`),
   * which is the only place that knows what did not arrive. It was never
   * reported at all, and publishQualityScore treats a missing value as zero
   * loss — so every publisher scored full marks on a fifth of the rubric no
   * matter how bad the uplink was.
   */
  async getStats(): Promise<BroadcastStats | null> {
    if (!this.pc) return null;
    const report = await this.pc.getStats();

    let framesPerSecond: number | undefined;
    let rttMs: number | undefined;
    let packetLossPct: number | undefined;
    let bytesSent: number | undefined;
    let packetsSent: number | undefined;
    let packetsLost: number | undefined;

    report.forEach((stat) => {
      if (stat.type === "outbound-rtp" && !stat.isRemote) {
        if (typeof stat.framesPerSecond === "number") framesPerSecond = stat.framesPerSecond;
        if (typeof stat.bytesSent === "number") bytesSent = (bytesSent ?? 0) + stat.bytesSent;
        if (typeof stat.packetsSent === "number") packetsSent = (packetsSent ?? 0) + stat.packetsSent;
      }
      if (stat.type === "remote-inbound-rtp") {
        if (typeof stat.packetsLost === "number") packetsLost = (packetsLost ?? 0) + stat.packetsLost;
        // The receiver's RTT is more accurate than the candidate pair's when
        // both are present, so it wins; the candidate pair fills in below.
        if (typeof stat.roundTripTime === "number") rttMs = Math.round(stat.roundTripTime * 1000);
      }
      if (stat.type === "candidate-pair" && stat.state === "succeeded") {
        if (rttMs == null && typeof stat.currentRoundTripTime === "number") {
          rttMs = Math.round(stat.currentRoundTripTime * 1000);
        }
      }
    });

    let bitrateKbps: number | undefined;
    const atMs = Date.now();
    if (bytesSent != null) {
      const prev = this.lastOutbound;
      if (prev && atMs > prev.atMs && bytesSent >= prev.bytes) {
        bitrateKbps = Math.round(((bytesSent - prev.bytes) * 8) / 1000 / ((atMs - prev.atMs) / 1000));
      }
      this.lastOutbound = { bytes: bytesSent, atMs };
    }

    if (packetsLost != null && packetsSent != null && packetsSent > 0) {
      packetLossPct = Math.max(0, Math.min(100, (packetsLost / packetsSent) * 100));
    }

    return { bitrateKbps, framesPerSecond, rttMs, packetLossPct };
  }
}
