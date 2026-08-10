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
  /**
   * Absolute, tokenized URL for a gateway-relative delivery path handed to us
   * by the gateway (`deliveries[].path`). The gateway decides which paths exist
   * and in what order; the SDK only resolves them against its own base and
   * attaches the access token. Anything that is not a plain gateway-relative
   * path is rejected rather than fetched: an absolute URL there would send the
   * token to a host we did not choose.
   */
  deliveryUrl(path: string): string {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
      throw mebiusError("CONNECTION_FAILED", "The gateway returned an unusable delivery path.");
    }
    return this.withToken(`${this.base()}${path}`);
  }

  /** Playlist URL for scale-mode playback. */
  scalePlaylistUrl(streamId: string): string {
    return this.withToken(`${this.base()}/live/${encodeURIComponent(streamId)}/index.m3u8`);
  }

  /**
   * Realtime captions SSE URL. Same play token as media — the engine's
   * `PlayVerifier` gates both, so a viewer who can watch the stream can already
   * read its captions with zero extra credential.
   *
   * `/api/v1/live/...`, NOT `/live/...`: unlike {@link scalePlaylistUrl}, which
   * hits the engine's bare `/live/*` media-edge catch-all, captions are mounted
   * under the versioned control-API group (mebius-stream-engine
   * internal/api/routes.go) with the play-token middleware, not the proxy.
   * Copying the media-edge prefix here 401s every request — the catch-all
   * doesn't recognise the path and never reaches the captions handler at all.
   */
  captionsUrl(streamId: string, lang: string): string {
    return this.withToken(
      `${this.base()}/api/v1/live/${encodeURIComponent(streamId)}/captions?lang=${encodeURIComponent(lang)}`,
    );
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
