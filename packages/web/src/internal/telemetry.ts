/**
 * INTERNAL — quality-of-experience reporting.
 *
 * Mebius shows per-stream publish/playback quality (bitrate, fps, rtt, freezes)
 * in the integrator's dashboard, and derives viewer minutes from play-side
 * reports. Both come from here: nothing else in the product observes a viewer's
 * actual experience, because only the client can see it.
 *
 * The credential and the endpoint both come from the token your backend already
 * fetches — the SDK is never configured with them and never learns which tenant
 * it belongs to. The token is scoped by signed claims to one stream and one
 * project, so it can only ever write its own telemetry.
 */

/** SDK identifier reported with each batch. Keep in step with package.json. */
const SDK_VERSION = "web/0.4.1";

/** How often a batch is sent. Long enough to batch, short enough to survive a tab close. */
const FLUSH_INTERVAL_MS = 15_000;

/**
 * Server cap on samples per request (beaconSchema: max 64). Flushing at this
 * point rather than growing without bound means a long broadcast on a throttled
 * network drops nothing to a 400.
 */
const MAX_BATCH = 64;

export interface QoeSample {
  /** Unix seconds. The server keys samples on this. */
  ts: number;
  bitrateKbps?: number;
  fps?: number;
  rttMs?: number;
  packetLossPct?: number;
  freezeMs?: number;
  firstFrameMs?: number;
}

export interface TelemetryTarget {
  /** Absolute beacon URL, as returned with the token. */
  url: string;
  /** Beacon credential, as returned with the token. */
  token: string;
}

/** Best-effort environment description. Absent fields are simply not reported. */
function describeDevice(): { os?: string; sdk: string } {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  // navigator.platform is deprecated but still the only universally available
  // hint; userAgentData exists on Chromium only. Neither is load-bearing — the
  // dashboard shows it as context, so a missing value costs nothing.
  const uaData = (nav as { userAgentData?: { platform?: string } } | undefined)?.userAgentData;
  return { os: uaData?.platform || nav?.platform || undefined, sdk: SDK_VERSION };
}

function describeNetwork(): { type?: string } | undefined {
  const conn = (
    typeof navigator === "undefined"
      ? undefined
      : (navigator as { connection?: { effectiveType?: string } }).connection
  );
  return conn?.effectiveType ? { type: conn.effectiveType } : undefined;
}

/**
 * Collects samples for one session and ships them in batches.
 *
 * Every failure path is silent by design: telemetry must never break playback or
 * a broadcast. A rejected batch is dropped rather than retried — the next batch
 * is 15s away and carries the same picture of stream health, so retrying would
 * only pile up requests against an endpoint that is already unhappy.
 */
export class QoeReporter {
  private readonly sessionId = randomId();
  private readonly buffer: QoeSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private unloadHandler: (() => void) | null = null;

  constructor(
    private readonly target: TelemetryTarget,
    private readonly role: "pub" | "play",
    private readonly streamId: string,
    private readonly userId?: string,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    // A viewer closing the tab is the normal end of a session, not an edge case:
    // without this the last interval of every session — and the watch time it
    // represents — is simply lost.
    if (typeof window !== "undefined") {
      this.unloadHandler = () => void this.flush(true);
      window.addEventListener("pagehide", this.unloadHandler);
    }
  }

  add(sample: QoeSample): void {
    this.buffer.push(sample);
    if (this.buffer.length >= MAX_BATCH) void this.flush();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.unloadHandler && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.unloadHandler);
    }
    this.unloadHandler = null;
    await this.flush();
  }

  /** Send and clear the buffer. `beacon` uses sendBeacon, for page-unload flushes. */
  async flush(beacon = false): Promise<void> {
    if (!this.buffer.length) return;
    const samples = this.buffer.splice(0, MAX_BATCH);
    const body = JSON.stringify({
      sessionId: this.sessionId,
      streamId: this.streamId,
      role: this.role,
      userId: this.userId,
      samples,
      device: describeDevice(),
      network: describeNetwork(),
    });

    // sendBeacon cannot carry an Authorization header, so the credential travels
    // as a query parameter on the unload path only. Same token, same scope — the
    // server accepts either, and losing the final batch of every session was the
    // alternative.
    if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      const url = `${this.target.url}${this.target.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.target.token)}`;
      try {
        // text/plain, not application/json: application/json makes this a
        // non-simple request, so the browser must clear a CORS preflight first —
        // during unload, when it frequently never completes and the beacon is
        // dropped without a trace. text/plain is on the safelist and goes
        // straight out. The server reads the body as JSON either way; content
        // type is not what it parses on.
        navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
      } catch {
        /* nothing to do at unload */
      }
      return;
    }

    try {
      await fetch(this.target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.target.token}` },
        body,
        keepalive: true,
      });
    } catch {
      /* telemetry never breaks the stream */
    }
  }
}

function randomId(): string {
  const c = typeof crypto === "undefined" ? undefined : crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Older Safari/WebView: a collision only merges two sessions' samples, so a
  // cheap fallback beats refusing to report at all.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
