/**
 * INTERNAL — gateway signaling client.
 *
 * This module is the ONE place that knows the wire protocols Mebius uses
 * behind the scenes (WHIP for publishing, WHEP for low-latency viewing, HLS
 * for scale viewing). None of these terms ever escape `internal/` — the public
 * API speaks only in Mebius vocabulary.
 *
 * The gateway HTTP contract (subject to the backend, mebius-stream-engine):
 *   - Publish:           POST  {gateway}/whip/{streamId}   (application/sdp)
 *   - View low-latency:  POST  {gateway}/whep/{streamId}   (application/sdp)
 *   - View scale:        GET   {gateway}/hls/{streamId}/index.m3u8
 *   - Teardown:          DELETE {resourceUrl}
 * Every request carries `Authorization: Bearer <token>`.
 */
import { mebiusError } from "../errors.js";

export type SignalingKind = "whip" | "whep";

export interface SdpExchangeResult {
  /** The remote SDP answer. */
  answerSdp: string;
  /** Resource URL to DELETE on teardown, if the gateway returned one. */
  resourceUrl: string | null;
}

export class SignalingClient {
  constructor(
    private readonly gateway: string,
    private readonly token: string,
  ) {}

  private base(): string {
    return this.gateway.replace(/\/+$/, "");
  }

  private headers(contentType?: string): HeadersInit {
    const h: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (contentType) h["Content-Type"] = contentType;
    return h;
  }

  // Build the playlist URL used by scale-mode playback (HLS path, hidden).
  /** Playlist URL for scale-mode playback. */
  scalePlaylistUrl(streamId: string): string {
    return `${this.base()}/hls/${encodeURIComponent(streamId)}/index.m3u8`;
  }

  // Build the HTTP-FLV pull URL used by balanced-mode playback. Served by the
  // CDN (CDN_PULL_FORMAT `.flv`) or an SRS/nginx-rtmp edge in front of the
  // engine — MediaMTX itself does not vend HTTP-FLV. Hidden from the public API.
  /** Pull URL for balanced-mode playback. */
  balancedStreamUrl(streamId: string): string {
    return `${this.base()}/flv/${encodeURIComponent(streamId)}.flv`;
  }

  // Performs the SDP offer/answer exchange for a publish (WHIP) or low-latency
  // view (WHEP) session. Protocol detail kept in line comments so it never
  // leaks into the bundled public .d.ts.
  /**
   * Run the session offer/answer exchange. Throws a {@link MebiusError} with a
   * Mebius-flavored code on failure — never the raw protocol name.
   */
  async exchangeSdp(
    kind: SignalingKind,
    streamId: string,
    offerSdp: string,
  ): Promise<SdpExchangeResult> {
    const url = `${this.base()}/${kind}/${encodeURIComponent(streamId)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: this.headers("application/sdp"),
        body: offerSdp,
      });
    } catch (cause) {
      throw mebiusError("CONNECTION_FAILED", undefined, cause);
    }

    if (res.status === 401 || res.status === 403) {
      throw mebiusError("TOKEN_EXPIRED");
    }
    if (res.status === 404) {
      throw mebiusError("STREAM_NOT_FOUND");
    }
    if (!res.ok) {
      throw mebiusError("CONNECTION_FAILED", `Mebius gateway returned ${res.status}.`);
    }

    const answerSdp = await res.text();
    const location = res.headers.get("Location");
    const resourceUrl = location ? new URL(location, url).toString() : null;
    return { answerSdp, resourceUrl };
  }

  /** Tear down a previously-created session resource. Best-effort. */
  async deleteResource(resourceUrl: string | null): Promise<void> {
    if (!resourceUrl) return;
    try {
      await fetch(resourceUrl, { method: "DELETE", headers: this.headers() });
    } catch {
      // Teardown is best-effort; the gateway reaps idle sessions anyway.
    }
  }
}
