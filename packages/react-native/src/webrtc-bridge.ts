/**
 * react-native-webrtc-backed implementation of {@link MebiusNativeBridge}.
 *
 * This is the real bridge: it performs the publish / low-latency view session
 * exchange against the Mebius gateway using the WebRTC peer
 * connections provided by `react-native-webrtc`. The host app installs that
 * library and registers the bridge once at startup:
 *
 * ```ts
 * import * as RNWebRTC from "react-native-webrtc";
 * import { registerWebRTCBridge } from "@mebius-io/react-native";
 * registerWebRTCBridge(RNWebRTC);
 * ```
 *
 * As everywhere in Mebius, the transport vocabulary stays inside
 * this internal module and never leaks into the public API.
 */
import { registerNativeBridge, type MebiusNativeBridge, type NativeHandle } from "./bridge.js";
import type {
  BroadcasterOptions,
  MebiusDelivery,
  MebiusInitOptions,
  PlaybackMode,
} from "./types.js";
import type {
  RNCodecCapability,
  RNMediaStream,
  RNPeerConnection,
  RNWebRTCModule,
} from "./rn-webrtc.js";

// --- Mebius-flavored error (mirrors the facade's MebiusError) -------------

type MebiusErrorCode =
  | "TOKEN_EXPIRED"
  | "PERMISSION_DENIED"
  | "CONNECTION_FAILED"
  | "NOT_CONNECTED"
  | "STREAM_NOT_FOUND"
  | "NOT_IMPLEMENTED"
  | "UNKNOWN";

class BridgeError extends Error {
  readonly code: MebiusErrorCode;
  constructor(code: MebiusErrorCode, message: string) {
    super(message);
    this.name = "MebiusError";
    this.code = code;
  }
}

// --- Gateway signaling ----------------------------------------------------
//
// The one place in this package that speaks to the wire transport. Same HTTP
// contract as @mebius-io/web: POST the SDP offer as application/sdp with the
// bearer token; the gateway replies with the SDP answer.

interface SdpExchangeResult {
  answerSdp: string;
  resourceUrl: string | null;
}

async function exchangeSdp(
  gateway: string,
  token: string,
  kind: "whip" | "whep",
  streamId: string,
  offerSdp: string,
): Promise<SdpExchangeResult> {
  const base = gateway.replace(/\/+$/, "");
  // The engine validates the token from the ?token= query (its auth hook reads
  // the query, not the header). Bearer is kept as a courtesy for gateways that
  // prefer it, but the query token is what the engine enforces.
  const url = `${base}/${kind}/${encodeURIComponent(streamId)}?token=${encodeURIComponent(token)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/sdp" },
      body: offerSdp,
    });
  } catch (cause) {
    throw new BridgeError("CONNECTION_FAILED", `Could not reach the Mebius gateway: ${String(cause)}`);
  }
  if (res.status === 401 || res.status === 403) throw new BridgeError("TOKEN_EXPIRED", "Mebius token expired.");
  if (res.status === 404) throw new BridgeError("STREAM_NOT_FOUND", "Mebius stream not found.");
  if (!res.ok) throw new BridgeError("CONNECTION_FAILED", `Mebius gateway returned ${res.status}.`);
  const answerSdp = await res.text();
  const location = res.headers.get("Location");
  const resourceUrl = location ? new URL(location, url).toString() : null;
  return { answerSdp, resourceUrl };
}

async function deleteResource(token: string, resourceUrl: string | null): Promise<void> {
  if (!resourceUrl) return;
  try {
    await fetch(resourceUrl, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  } catch {
    // Best-effort teardown; the gateway reaps idle sessions anyway.
  }
}

// --- Handle registry ------------------------------------------------------

interface ClientEntry {
  token: string;
  gateway: string;
  deliveries: readonly MebiusDelivery[];
}
interface BroadcasterEntry {
  client: ClientEntry;
  options: BroadcasterOptions;
  pc?: RNPeerConnection;
  stream?: RNMediaStream;
  resourceUrl: string | null;
}
interface PlayerEntry {
  client: ClientEntry;
  mode: PlaybackMode;
  pc?: RNPeerConnection;
  remote?: RNMediaStream;
  resourceUrl: string | null;
  listeners: Map<string, Set<(payload: unknown) => void>>;
}

let counter = 0;
function nextHandle(prefix: string): NativeHandle {
  counter += 1;
  return `${prefix}_${counter}`;
}

/**
 * Resolve the playlist URL for a viewer.
 *
 * Prefers a gateway-supplied delivery, which is served from an edge and costs us
 * nothing per viewer; the origin playlist is the fallback and is billed to us for
 * every mobile viewer, so it must never be the first choice when an edge route
 * was offered. Deliveries whose path is not plainly gateway-relative are ignored
 * rather than fetched — an absolute path there would send the viewer's token to a
 * host we did not choose.
 */
function playbackUrl(client: ClientEntry, streamId: string): string {
  const base = client.gateway.replace(/\/+$/, "");
  const token = `token=${encodeURIComponent(client.token)}`;
  const usable = client.deliveries.find(
    (d) =>
      (d.kind === "wide" || d.kind === "local") &&
      d.path.startsWith("/") &&
      !d.path.startsWith("//") &&
      !d.path.includes("://"),
  );
  const path = usable?.path ?? `/live/${encodeURIComponent(streamId)}/index.m3u8`;
  return `${base}${path}${path.includes("?") ? "&" : "?"}${token}`;
}

function rtcConfig(): Record<string, unknown> {
  return { sdpSemantics: "unified-plan", bundlePolicy: "max-bundle" };
}

/**
 * Offer H264 ahead of everything else for the outgoing video track.
 *
 * Same reason as the web SDK: libwebrtc offers VP8 first, and the server's
 * HLS/FLV/CDN muxers cannot carry VP8 — they drop the video track and publish
 * an audio-only stream. The broadcast looks healthy on the device and has no
 * picture for anyone watching outside the real-time route.
 *
 * Both APIs used here landed in react-native-webrtc 111. On an older host they
 * are simply absent and negotiation keeps its default order, which is the same
 * behaviour this SDK had before.
 */
export function preferH264(rtc: RNWebRTCModule, pc: RNPeerConnection): void {
  const codecs = rtc.RTCRtpSender?.getCapabilities?.("video")?.codecs;
  if (!codecs?.length || !pc.getTransceivers) return;
  const isH264 = (c: RNCodecCapability) => c.mimeType.toLowerCase() === "video/h264";
  const h264 = codecs.filter(isH264);
  if (h264.length === 0) return;
  const ordered = [...h264, ...codecs.filter((c) => !isH264(c))];
  for (const tr of pc.getTransceivers()) {
    if (tr.sender?.track?.kind !== "video") continue;
    try {
      tr.setCodecPreferences?.(ordered);
    } catch {
      // A host that rejects the list negotiates its own way.
    }
  }
}

/**
 * Build a {@link MebiusNativeBridge} backed by `react-native-webrtc`.
 * Exposed for testing / advanced wiring; most apps call
 * {@link registerWebRTCBridge} instead.
 */
export function createWebRTCBridge(rtc: RNWebRTCModule): MebiusNativeBridge {
  let config: MebiusInitOptions | null = null;
  const clients = new Map<NativeHandle, ClientEntry>();
  const broadcasters = new Map<NativeHandle, BroadcasterEntry>();
  const players = new Map<NativeHandle, PlayerEntry>();

  function clientOf(handle: NativeHandle): ClientEntry {
    const b = broadcasters.get(handle);
    if (b) return b.client;
    const p = players.get(handle);
    if (p) return p.client;
    throw new BridgeError("NOT_CONNECTED", "Unknown Mebius handle.");
  }

  function emit(entry: PlayerEntry, event: string, payload: unknown): void {
    entry.listeners.get(event)?.forEach((cb) => cb(payload));
  }

  return {
    init(options: MebiusInitOptions): void {
      config = { ...options };
    },

    async connect(token: string, deliveries: readonly MebiusDelivery[] = []): Promise<NativeHandle> {
      if (!config) throw new BridgeError("UNKNOWN", "Call Mebius.init() before connect().");
      const handle = nextHandle("client");
      clients.set(handle, { token, gateway: config.gateway, deliveries });
      return handle;
    },

    disconnect(client: NativeHandle): void {
      clients.delete(client);
    },

    async createBroadcaster(client: NativeHandle, options: BroadcasterOptions): Promise<NativeHandle> {
      const c = clients.get(client);
      if (!c) throw new BridgeError("NOT_CONNECTED", "Connect before creating a broadcaster.");
      const handle = nextHandle("broadcaster");
      broadcasters.set(handle, { client: c, options, resourceUrl: null });
      return handle;
    },

    async broadcasterStart(handle: NativeHandle, streamId: string): Promise<void> {
      const entry = broadcasters.get(handle);
      if (!entry) throw new BridgeError("NOT_CONNECTED", "Unknown broadcaster handle.");
      const wantVideo = entry.options.video !== false;
      const wantAudio = entry.options.audio !== false;
      let stream: RNMediaStream;
      try {
        stream = await rtc.mediaDevices.getUserMedia({ video: wantVideo, audio: wantAudio });
      } catch (cause) {
        throw new BridgeError("PERMISSION_DENIED", `Camera/microphone access failed: ${String(cause)}`);
      }
      const pc = new rtc.RTCPeerConnection(rtcConfig());
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      preferH264(rtc, pc);
      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      const { answerSdp, resourceUrl } = await exchangeSdp(
        entry.client.gateway,
        entry.client.token,
        "whip",
        streamId,
        offer.sdp,
      );
      await pc.setRemoteDescription(new rtc.RTCSessionDescription({ type: "answer", sdp: answerSdp }));
      entry.pc = pc;
      entry.stream = stream;
      entry.resourceUrl = resourceUrl;
    },

    async broadcasterStop(handle: NativeHandle): Promise<void> {
      const entry = broadcasters.get(handle);
      if (!entry) return;
      entry.stream?.getTracks().forEach((t) => t.stop());
      entry.pc?.close();
      await deleteResource(entry.client.token, entry.resourceUrl);
      broadcasters.delete(handle);
    },

    async broadcasterSwitchCamera(handle: NativeHandle): Promise<void> {
      // react-native-webrtc exposes _switchCamera() on the video track.
      const track = broadcasters.get(handle)?.stream?.getVideoTracks()[0] as
        | { _switchCamera?: () => void }
        | undefined;
      track?._switchCamera?.();
    },

    broadcasterSetMicEnabled(handle: NativeHandle, enabled: boolean): void {
      broadcasters.get(handle)?.stream?.getAudioTracks().forEach((t) => (t.enabled = enabled));
    },

    broadcasterSetCameraEnabled(handle: NativeHandle, enabled: boolean): void {
      broadcasters.get(handle)?.stream?.getVideoTracks().forEach((t) => (t.enabled = enabled));
    },

    async createPlayer(client: NativeHandle, mode: PlaybackMode): Promise<NativeHandle> {
      const c = clients.get(client);
      if (!c) throw new BridgeError("NOT_CONNECTED", "Connect before creating a player.");
      const handle = nextHandle("player");
      players.set(handle, { client: c, mode, resourceUrl: null, listeners: new Map() });
      return handle;
    },

    async playerPlay(handle: NativeHandle, streamId: string, viewTag: number): Promise<void> {
      // `viewTag` is accepted for API parity with the native-view contract;
      // react-native-webrtc renders via a stream URL delivered on the "stream"
      // event, so the tag itself is not consumed here.
      void viewTag;
      const entry = players.get(handle);
      if (!entry) throw new BridgeError("NOT_CONNECTED", "Unknown player handle.");
      if (entry.mode === "scale" || entry.mode === "auto") {
        // Playlist playback: render with a video component pointed at the URL
        // rather than a peer connection. The bridge surfaces the URL.
        //
        // Two bugs lived in the previous three lines. It built `/hls/{id}/index.m3u8`,
        // a prefix the gateway has never routed or allowlisted, and it attached no
        // `?token=`, which the playback gate requires — so this path could only ever
        // 404 or 401. It now uses the gateway's own delivery list and falls back to
        // the origin playlist the gateway does route.
        emit(entry, "stream", { url: playbackUrl(entry.client, streamId), kind: entry.mode });
        return;
      }
      const pc = new rtc.RTCPeerConnection(rtcConfig());
      pc.ontrack = (event) => {
        const remote = event.streams?.[0];
        if (remote) {
          entry.remote = remote;
          // Deliver the stream URL so a Mebius view component can render it.
          // `viewTag` is accepted for API parity but rendering is event-driven
          // in react-native-webrtc (RTCView consumes a stream URL).
          emit(entry, "stream", { url: remote.toURL(), kind: "low-latency" });
        }
      };
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      const { answerSdp, resourceUrl } = await exchangeSdp(
        entry.client.gateway,
        entry.client.token,
        "whep",
        streamId,
        offer.sdp,
      );
      await pc.setRemoteDescription(new rtc.RTCSessionDescription({ type: "answer", sdp: answerSdp }));
      entry.pc = pc;
      entry.resourceUrl = resourceUrl;
    },

    async playerStop(handle: NativeHandle): Promise<void> {
      const entry = players.get(handle);
      if (!entry) return;
      entry.pc?.close();
      await deleteResource(entry.client.token, entry.resourceUrl);
      players.delete(handle);
    },

    playerSetVolume(handle: NativeHandle, volume: number): void {
      // react-native-webrtc has no per-stream gain; approximate by toggling the
      // remote audio track (0 -> muted, >0 -> audible).
      players.get(handle)?.remote?.getAudioTracks().forEach((t) => (t.enabled = volume > 0));
    },

    addListener(handle: NativeHandle, event: string, cb: (payload: unknown) => void): () => void {
      const entry = players.get(handle);
      if (!entry) {
        // Broadcasters currently emit no events; return a no-op unsubscribe.
        clientOf(handle);
        return () => {};
      }
      let set = entry.listeners.get(event);
      if (!set) {
        set = new Set();
        entry.listeners.set(event, set);
      }
      set.add(cb);
      return () => {
        entry.listeners.get(event)?.delete(cb);
      };
    },
  };
}

/**
 * Register the `react-native-webrtc`-backed bridge as the active Mebius native
 * bridge. Call once at app startup, passing the imported `react-native-webrtc`
 * module:
 *
 * ```ts
 * import * as RNWebRTC from "react-native-webrtc";
 * registerWebRTCBridge(RNWebRTC);
 * ```
 */
export function registerWebRTCBridge(rtc: RNWebRTCModule): void {
  registerNativeBridge(createWebRTCBridge(rtc));
}
