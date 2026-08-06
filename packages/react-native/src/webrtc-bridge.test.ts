import { describe, expect, it, vi } from "vitest";
import { preferH264 } from "./webrtc-bridge.js";
import type { RNPeerConnection, RNWebRTCModule } from "./rn-webrtc.js";

const CODECS = [
  { mimeType: "video/VP8" },
  { mimeType: "video/H264" },
  { mimeType: "video/AV1" },
];

function host(codecs = CODECS): RNWebRTCModule {
  return { RTCRtpSender: { getCapabilities: () => ({ codecs }) } } as unknown as RNWebRTCModule;
}

function peer(setCodecPreferences = vi.fn(), kind = "video"): RNPeerConnection {
  return {
    getTransceivers: () => [{ sender: { track: { kind } }, setCodecPreferences }],
  } as unknown as RNPeerConnection;
}

describe("preferH264", () => {
  it("puts H264 first so the server can mux the stream for non-WebRTC viewers", () => {
    const set = vi.fn();
    preferH264(host(), peer(set));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0].map((c: { mimeType: string }) => c.mimeType)).toEqual([
      "video/H264",
      "video/VP8",
      "video/AV1",
    ]);
  });

  it("leaves the audio transceiver alone", () => {
    const set = vi.fn();
    preferH264(host(), peer(set, "audio"));
    expect(set).not.toHaveBeenCalled();
  });

  it("does nothing when the host cannot encode H264", () => {
    const set = vi.fn();
    preferH264(host([{ mimeType: "video/VP8" }]), peer(set));
    expect(set).not.toHaveBeenCalled();
  });

  it("does nothing on a react-native-webrtc older than 111", () => {
    // Neither API exists there; the broadcast must still go out, unreordered.
    expect(() =>
      preferH264({} as RNWebRTCModule, { } as RNPeerConnection),
    ).not.toThrow();
  });
});
