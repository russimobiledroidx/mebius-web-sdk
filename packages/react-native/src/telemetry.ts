/**
 * INTERNAL — session reporting.
 *
 * Mebius derives viewer minutes from client reports: the span between a viewing
 * session's first and last sample IS the watch time on the bill. Without this a
 * React Native viewer watches for an hour and is counted as zero.
 *
 * What this deliberately does NOT do: quality metrics. This package has no stats
 * surface — the native bridge exposes no getStats, and neither the broadcaster nor
 * the player emits a stats event — so there are no real bitrate/fps/rtt numbers to
 * report, and inventing them would put fiction in a dashboard people bill from.
 * Samples here carry a timestamp only, which is enough for presence and watch
 * time, and the quality columns stay honestly empty.
 *
 * ponytail: presence-only reporting. Add metrics here once the bridge exposes
 * per-connection stats (react-native-webrtc's peer connection can provide them);
 * the batching and the endpoint contract below do not change.
 */

/** SDK identifier reported with each batch. Keep in step with package.json. */
const SDK_VERSION = "react-native/0.4.1";

/** How often presence is reported. Also the resolution of the resulting watch time. */
const HEARTBEAT_MS = 15_000;

/** Server cap on samples per request (beaconSchema: max 64). */
const MAX_BATCH = 64;

export interface TelemetryTarget {
  /** Absolute beacon URL, as returned with the token. */
  url: string;
  /** Beacon credential, as returned with the token. */
  token: string;
}

/**
 * Reports that a session is alive, in batches, until stopped.
 *
 * Failures are swallowed and never retried: telemetry must not break a broadcast
 * or a viewer's playback, and the next heartbeat is 15s away carrying the same
 * information.
 */
export class SessionReporter {
  private readonly sessionId = randomId();
  private readonly buffer: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly target: TelemetryTarget,
    private readonly role: "pub" | "play",
    private readonly streamId: string,
    private readonly userId?: string,
  ) {}

  start(): void {
    if (this.timer) return;
    // Report immediately: a viewer who leaves inside the first interval still
    // watched, and would otherwise never appear at all.
    this.beat();
    this.timer = setInterval(() => {
      this.beat();
      void this.flush();
    }, HEARTBEAT_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // One last beat so the reported span reaches the moment of leaving rather than
    // the previous heartbeat.
    this.beat();
    await this.flush();
  }

  private beat(): void {
    this.buffer.push(Math.floor(Date.now() / 1000));
    if (this.buffer.length >= MAX_BATCH) void this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.buffer.length) return;
    const ts = this.buffer.splice(0, MAX_BATCH);
    try {
      await fetch(this.target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.target.token}` },
        body: JSON.stringify({
          sessionId: this.sessionId,
          streamId: this.streamId,
          role: this.role,
          userId: this.userId,
          samples: ts.map((t) => ({ ts: t })),
          device: { sdk: SDK_VERSION },
        }),
      });
    } catch {
      /* telemetry never breaks the stream */
    }
  }
}

function randomId(): string {
  const c = typeof crypto === "undefined" ? undefined : (crypto as { randomUUID?: () => string });
  if (c?.randomUUID) return c.randomUUID();
  // React Native runtimes without crypto.randomUUID: a collision only merges two
  // sessions, which beats not reporting.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
