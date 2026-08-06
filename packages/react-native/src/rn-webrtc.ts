/**
 * Minimal structural typing for the parts of `react-native-webrtc` the Mebius
 * bridge uses. Declared locally so this package compiles and type-checks
 * WITHOUT `react-native-webrtc` installed (it is an optional peer dependency
 * the host app provides). As with every Mebius surface, none of these
 * transport types are re-exported publicly.
 */

export interface RNMediaStreamTrack {
  kind: string;
  enabled: boolean;
  stop(): void;
}

export interface RNMediaStream {
  toURL(): string;
  getTracks(): RNMediaStreamTrack[];
  getAudioTracks(): RNMediaStreamTrack[];
  getVideoTracks(): RNMediaStreamTrack[];
}

export interface RNRtpReceiver {
  track?: RNMediaStreamTrack | null;
}

export interface RNTrackEvent {
  track?: RNMediaStreamTrack | null;
  streams?: RNMediaStream[];
  receiver?: RNRtpReceiver;
}

export interface RNSessionDescription {
  type: string;
  sdp: string;
}

export interface RNRtpTransceiverInit {
  direction: "sendrecv" | "sendonly" | "recvonly" | "inactive";
}

/** Codec descriptor as `RTCRtpSender.getCapabilities` reports it. */
export interface RNCodecCapability {
  mimeType: string;
}

export interface RNRtpTransceiver {
  sender?: { track?: { kind?: string } | null } | null;
  setCodecPreferences?(codecs: RNCodecCapability[]): void;
}

export interface RNPeerConnection {
  addTrack(track: RNMediaStreamTrack, stream: RNMediaStream): unknown;
  /** Present from react-native-webrtc 111; absent on older hosts. */
  getTransceivers?(): RNRtpTransceiver[];
  addTransceiver(kind: "audio" | "video", init?: RNRtpTransceiverInit): unknown;
  createOffer(options?: Record<string, unknown>): Promise<RNSessionDescription>;
  setLocalDescription(desc: RNSessionDescription): Promise<void>;
  setRemoteDescription(desc: RNSessionDescription): Promise<void>;
  close(): void;
  ontrack: ((event: RNTrackEvent) => void) | null;
  onconnectionstatechange: (() => void) | null;
  connectionState: string;
}

export interface RNPeerConnectionCtor {
  new (config?: Record<string, unknown>): RNPeerConnection;
}

export interface RNSessionDescriptionCtor {
  new (init: { type: string; sdp: string }): RNSessionDescription;
}

export interface RNMediaDevices {
  getUserMedia(constraints: { audio?: boolean; video?: boolean }): Promise<RNMediaStream>;
}

/** The subset of the `react-native-webrtc` module Mebius depends on. */
export interface RNWebRTCModule {
  RTCPeerConnection: RNPeerConnectionCtor;
  RTCSessionDescription: RNSessionDescriptionCtor;
  mediaDevices: RNMediaDevices;
  /** Present from react-native-webrtc 111; absent on older hosts. */
  RTCRtpSender?: {
    getCapabilities?(kind: string): { codecs?: RNCodecCapability[] } | null;
  };
}
