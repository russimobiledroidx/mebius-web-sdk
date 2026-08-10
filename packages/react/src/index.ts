/**
 * @mebius-io/react — React hooks for the Mebius Web SDK.
 *
 * Thin wrappers over @mebius-io/web: they manage React lifecycle (effects, refs,
 * state) but contain no streaming logic of their own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mebius,
  type BroadcasterOptions,
  type CaptionSegment,
  type MebiusClient,
  type MebiusBroadcaster,
  type MebiusPlayer,
  type PlayerOptions,
  type MebiusError,
  type MebiusDelivery,
} from "@mebius-io/web";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

export interface UseMebiusOptions {
  appId: string;
  gateway: string;
  token: string;
  /**
   * The `deliveries` list your backend returned with the token. Pass it through
   * as-is. Keep the array reference stable (or memoize it) — a new array on every
   * render reconnects the client.
   */
  deliveries?: MebiusDelivery[];
  /**
   * Quality reporting credential + endpoint, from the same token response
   * (`beaconToken` / `beaconUrl`). Pass them and this stream's publish/playback
   * quality shows up in your Mebius dashboard, and viewer minutes are counted.
   *
   * Optional: without them the stream behaves identically, you just see no
   * quality data. Safe in a client — the credential is bound by signed claims to
   * one stream and one project.
   */
  beaconToken?: string;
  beaconUrl?: string;
  /** Your own id for the person on this connection, if you want it in reports. */
  userId?: string;
}

export interface UseMebiusResult {
  client: MebiusClient | null;
  status: ConnectionStatus;
  error: MebiusError | null;
}

/** Init + connect, tied to component lifecycle. Reconnects if token changes. */
export function useMebius({
  appId,
  gateway,
  token,
  deliveries,
  beaconToken,
  beaconUrl,
  userId,
}: UseMebiusOptions): UseMebiusResult {
  const [client, setClient] = useState<MebiusClient | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<MebiusError | null>(null);

  useEffect(() => {
    if (!token) return;
    Mebius.init({ appId, gateway });
    setStatus("connecting");
    const c = Mebius.connect({ token, deliveries, beaconToken, beaconUrl, userId });
    const offConnected = c.on("connected", () => setStatus("connected"));
    const offError = c.on("error", (e) => {
      setError(e);
      setStatus("error");
    });
    setClient(c);
    return () => {
      offConnected();
      offError();
      c.disconnect();
      setClient(null);
      setStatus("idle");
    };
    // The beacon values belong in the dependency list: they arrive with the token
    // and change with it, so omitting them would keep reporting under a credential
    // for the previous stream after a reconnect.
  }, [appId, gateway, token, deliveries, beaconToken, beaconUrl, userId]);

  return { client, status, error };
}

export interface UseBroadcasterResult {
  broadcaster: MebiusBroadcaster | null;
  previewRef: React.RefObject<HTMLVideoElement>;
  start: (streamId: string) => Promise<void>;
  stop: () => Promise<void>;
  switchCamera: () => Promise<void>;
  setMicEnabled: (enabled: boolean) => void;
  setCameraEnabled: (enabled: boolean) => void;
  isLive: boolean;
}

/** Create + drive a broadcaster. */
export function useBroadcaster(
  client: MebiusClient | null,
  options: BroadcasterOptions = {},
): UseBroadcasterResult {
  const previewRef = useRef<HTMLVideoElement>(null);
  const [broadcaster, setBroadcaster] = useState<MebiusBroadcaster | null>(null);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    if (!client) return;
    const b = client.createBroadcaster(options);
    const offStarted = b.on("started", () => setIsLive(true));
    const offStopped = b.on("stopped", () => setIsLive(false));
    setBroadcaster(b);
    return () => {
      offStarted();
      offStopped();
      void b.stop();
      setBroadcaster(null);
    };
  }, [client]);

  const start = useCallback(
    async (streamId: string) => {
      if (!broadcaster) return;
      await broadcaster.start(streamId);
      if (previewRef.current) broadcaster.attachPreview(previewRef.current);
    },
    [broadcaster],
  );
  const stop = useCallback(async () => broadcaster?.stop(), [broadcaster]);
  const switchCamera = useCallback(async () => broadcaster?.switchCamera(), [broadcaster]);
  const setMicEnabled = useCallback((e: boolean) => broadcaster?.setMicEnabled(e), [broadcaster]);
  const setCameraEnabled = useCallback(
    (e: boolean) => broadcaster?.setCameraEnabled(e),
    [broadcaster],
  );

  return {
    broadcaster,
    previewRef,
    start,
    stop,
    switchCamera,
    setMicEnabled,
    setCameraEnabled,
    isLive,
  };
}

export interface UsePlayerResult {
  player: MebiusPlayer | null;
  videoRef: React.RefObject<HTMLVideoElement>;
  play: (streamId: string) => Promise<void>;
  stop: () => Promise<void>;
  setVolume: (v: number) => void;
  isPlaying: boolean;
}

/** Create + drive a player, rendering into the returned `videoRef`. */
export function usePlayer(
  client: MebiusClient | null,
  options: PlayerOptions,
): UsePlayerResult {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [player, setPlayer] = useState<MebiusPlayer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (!client) return;
    const p = client.createPlayer(options);
    const offPlaying = p.on("playing", () => setIsPlaying(true));
    const offEnded = p.on("ended", () => setIsPlaying(false));
    setPlayer(p);
    return () => {
      offPlaying();
      offEnded();
      void p.stop();
      setPlayer(null);
    };
  }, [client, options.mode]);

  const play = useCallback(
    async (streamId: string) => {
      if (player && videoRef.current) await player.play(streamId, videoRef.current);
    },
    [player],
  );
  const stop = useCallback(async () => player?.stop(), [player]);
  const setVolume = useCallback((v: number) => player?.setVolume(v), [player]);

  return { player, videoRef, play, stop, setVolume, isPlaying };
}

export interface UseCaptionsResult {
  /** The active segment for `lang`, or `null` when none is due right now. */
  segment: CaptionSegment | null;
}

/**
 * Subscribe to realtime captions for whatever `player` is currently showing.
 *
 * Does NOT start the caption session — that spends money and needs an API key,
 * so it is a call your own backend makes to
 * `POST /api/v1/live/{streamId}/captions/start` (see
 * mebius-stream-engine/docs/API.md §5.1) before this hook has anything to show.
 * This only reads the feed a session already produces.
 *
 * `streamId` must be the one `player` is playing. `lang` must match a
 * `targetLangs` entry the session was started with, or every segment arrives
 * with no translation for it.
 */
export function useCaptions(
  client: MebiusClient | null,
  player: MebiusPlayer | null,
  streamId: string | null,
  lang: string,
): UseCaptionsResult {
  const [segment, setSegment] = useState<CaptionSegment | null>(null);

  useEffect(() => {
    if (!client || !player || !streamId) return;
    const captions = client.createCaptions(player, { lang });
    // A revision or a newer segment simply replaces what's shown; only
    // "cleared" for the segment currently on screen should blank it, otherwise
    // an unrelated segment aging out of the buffer would flash the caption off.
    const offSegment = captions.on("segment", (seg) => setSegment(seg));
    const offCleared = captions.on("cleared", ({ segmentId }) => {
      setSegment((cur) => (cur?.segmentId === segmentId ? null : cur));
    });
    captions.start(streamId);
    return () => {
      offSegment();
      offCleared();
      captions.stop();
      setSegment(null);
    };
  }, [client, player, streamId, lang]);

  return { segment };
}
