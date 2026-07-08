/**
 * INTERNAL — gateway signaling client.
 *
 * This module is the ONE place that knows the wire protocols Mebius uses
 * behind the scenes (WHIP for publishing, WHEP for low-latency viewing, HLS
 * for scale viewing). None of these terms ever escape `internal/` — the public
 * API speaks only in Mebius vocabulary.
 *
 * The gateway HTTP contract (mebius-stream-engine public edge):
 *   - Publish:           POST  {gateway}/whip/{streamId}?token=<jwt>   (application/sdp)
 *   - View low-latency:  POST  {gateway}/whep/{streamId}?token=<jwt>   (application/sdp)
 *   - View scale:        GET   {gateway}/live/{streamId}/index.m3u8?token=<jwt>
 *   - Teardown:          DELETE {resourceUrl}
 *
 * The engine validates the token from the `?token=` QUERY parameter (its
 * MediaMTX auth hook + HLS playback gate both read the query, not a header).
 * We still send `Authorization: Bearer <token>` for gateways that prefer it,
 * but the query token is what the engine actually enforces. HLS segment URLs
 * inside the playlist inherit `?token=` automatically (the engine rewrites the
 * m3u8), so no extra header is needed for segment fetches.
 */
import { mebiusError } from "../errors.js";

/**
 * A media session direction. Deliberately neutral vocabulary ("publish" /
 * "view") so that if a type bundler ever inlines this into the public `.d.ts`
 * (e.g. via a private field reference), no wire-protocol term leaks to clients.
 * The concrete path segment is derived inside {@link SignalingClient} only.
 */
export type SessionKind = "publish" | "view";

export interface SessionResult {
  /** The remote session answer returned by the gateway. */
  answer: string;
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

  /** Append the access token as a query param (the form the engine enforces). */
  private withToken(url: string): string {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}token=${encodeURIComponent(this.token)}`;
  }

  // Build the playlist URL used by scale-mode playback (HLS path, hidden). The
  // engine serves the playlist under /live/{id}/index.m3u8 and requires the
  // token in the query; segment URIs in the playlist inherit it automatically.
  /** Playlist URL for scale-mode playback. */
  scalePlaylistUrl(streamId: string): string {
    return this.withToken(`${this.base()}/live/${encodeURIComponent(streamId)}/index.m3u8`);
  }

  // Build the HTTP-FLV pull URL used by balanced-mode playback. Served by the
  // CDN (CDN_PULL_FORMAT `.flv`) or an SRS/nginx-rtmp edge in front of the
  // engine — MediaMTX itself does not vend HTTP-FLV. Hidden from the public API.
  /** Pull URL for balanced-mode playback. */
  balancedStreamUrl(streamId: string): string {
    return this.withToken(`${this.base()}/flv/${encodeURIComponent(streamId)}.flv`);
  }

  // Maps a neutral session kind to the concrete signaling path segment. This
  // mapping (publish -> WHIP, view -> WHEP) lives ONLY in this method body, so
  // the protocol names never appear in any exported type signature.
  private pathFor(kind: SessionKind): string {
    return kind === "publish" ? "whip" : "whep";
  }

  // Performs the offer/answer exchange for a publish or a low-latency view
  // session. Protocol detail kept inside the method body so it never leaks into
  // the bundled public .d.ts.
  /**
   * Run the session offer/answer exchange. Throws a {@link MebiusError} with a
   * Mebius-flavored code on failure — never the raw protocol name.
   */
  async exchangeSession(
    kind: SessionKind,
    streamId: string,
    offer: string,
  ): Promise<SessionResult> {
    const url = this.withToken(`${this.base()}/${this.pathFor(kind)}/${encodeURIComponent(streamId)}`);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: this.headers("application/sdp"),
        body: offer,
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

    const answer = await res.text();
    const location = res.headers.get("Location");
    const resourceUrl = location ? new URL(location, url).toString() : null;
    return { answer, resourceUrl };
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
