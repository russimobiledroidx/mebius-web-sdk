import { MebiusBroadcaster } from "./broadcaster.js";
import { mebiusError, MebiusError } from "./errors.js";
import { TypedEmitter, type ScreenShareEventMap } from "./events.js";
import { reconnectDelayMs, responseError, sseParser } from "./internal/screen.js";
import { SignalingClient } from "./internal/signaling.js";
import type {
  ScreenCredentials,
  ScreenCredentialStore,
  ScreenDeviceInfo,
  ScreenShareOptions,
} from "./types.js";

function isCredentials(v: unknown): v is ScreenCredentials {
  const c = v as Partial<ScreenCredentials> | null;
  return (
    typeof c?.deviceId === "string" &&
    !!c.deviceId &&
    typeof c.deviceSecret === "string" &&
    !!c.deviceSecret
  );
}

/**
 * The default store: this browser's `localStorage`, one entry per engine, so a
 * page that talks to staging and production keeps two devices apart. Every
 * access is guarded, since storage can be disabled or full; a browser that
 * cannot keep the credentials simply enrolls again next time.
 */
function localCredentials(gateway: string): ScreenCredentialStore {
  const key = `mebius.screen.device:${gateway.replace(/\/+$/, "")}`;
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
        return isCredentials(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    save(credentials) {
      try {
        localStorage.setItem(key, JSON.stringify(credentials));
      } catch {
        /* see above */
      }
    },
    clear() {
      try {
        localStorage.removeItem(key);
      } catch {
        /* see above */
      }
    },
  };
}

/** An event from the device's event stream. `input` is not handled in a browser. */
type AgentEvent =
  | {
      type: "session.start";
      sessionId: string;
      mode: "view" | "control";
      userId?: string;
      publishToken: string;
      maxBitrateKbps?: number;
      iceServers?: RTCIceServer[];
    }
  | { type: "session.stop"; sessionId: string }
  | { type: "input" };

/**
 * Shares this browser's screen with the admins your backend lets watch it, on
 * the user's consent: the device is online only between {@link start} and
 * {@link stop}, and the browser asks the user which screen to share.
 *
 * Remote control is not possible from a browser; a `control` session is
 * watched like a `view` one.
 *
 * Create one with {@link Mebius.createScreenShare}.
 */
export class MebiusScreenShare extends TypedEmitter<ScreenShareEventMap> {
  private readonly credentials: ScreenCredentialStore;
  private source: MediaStream | null = null;
  private abort: AbortController | null = null;
  private session: { id: string; broadcaster: MebiusBroadcaster } | null = null;
  /** Events are handled one after another, so a stop never overtakes its start. */
  private queue: Promise<void> = Promise.resolve();
  /** The start() in progress, so a second click joins it instead of opening a second picker. */
  private starting: Promise<void> | null = null;
  /** Bumped by stop(), so a start() still in the picker knows to back out. */
  private generation = 0;

  /** @internal */
  constructor(
    private readonly gateway: string,
    options: ScreenShareOptions = {},
  ) {
    super();
    this.credentials = options.credentials ?? localCredentials(gateway);
  }

  private url(path: string): string {
    return `${this.gateway.replace(/\/+$/, "")}/api/v1/screen/agent/${path}`;
  }

  /**
   * Enroll this browser with a one-time code from your backend, unless it
   * already is. A code is single-use and valid for an hour.
   */
  async enrollIfNeeded(code: string, device: ScreenDeviceInfo = {}): Promise<void> {
    if (await this.credentials.load()) return;
    let res: Response;
    try {
      res = await fetch(this.url("enroll"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enrollToken: code,
          name: device.name ?? "browser",
          os: device.os ?? "web",
        }),
      });
    } catch (cause) {
      throw mebiusError("CONNECTION_FAILED", undefined, cause);
    }
    if (!res.ok) throw await responseError(res);
    const body: unknown = await res.json().catch(() => null);
    if (!isCredentials(body))
      throw mebiusError("CONNECTION_FAILED", "Mebius returned no device credentials.");
    await this.credentials.save({ deviceId: body.deviceId, deviceSecret: body.deviceSecret });
  }

  /**
   * Ask the user which screen to share, then put this device online. Call it
   * straight from a click handler: the browser only shows its picker in
   * response to a user gesture.
   */
  start(): Promise<void> {
    if (this.source) return Promise.resolve();
    if (!this.starting) {
      const p = this.open();
      this.starting = p;
      void p.catch(() => undefined).finally(() => (this.starting = null));
    }
    return this.starting;
  }

  private async open(): Promise<void> {
    const generation = this.generation;
    let source: MediaStream;
    try {
      // First, before anything else is awaited: an await in between spends the
      // click, and the browser refuses the picker.
      source = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (cause) {
      throw mebiusError("PERMISSION_DENIED", "Screen sharing was not allowed.", cause);
    }
    const credentials = await this.credentials.load();
    if (generation !== this.generation) {
      // stop() was called while the picker was open.
      source.getTracks().forEach((t) => t.stop());
      return;
    }
    if (!credentials) {
      source.getTracks().forEach((t) => t.stop());
      throw mebiusError("UNKNOWN", "This browser is not enrolled. Call enrollIfNeeded() first.");
    }
    for (const track of source.getVideoTracks()) {
      track.contentHint = "detail"; // keep text sharp rather than motion smooth
      // The user ended sharing from the browser's own controls.
      track.addEventListener("ended", () => void this.stop());
    }
    this.source = source;
    this.abort = new AbortController();
    void this.listen(credentials.deviceSecret, this.abort.signal);
  }

  /** Stop sharing and take this device offline. */
  async stop(): Promise<void> {
    this.generation++;
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    // The screen stops being captured first, whatever else might hang below.
    source.getTracks().forEach((t) => t.stop());
    this.abort?.abort();
    this.abort = null;
    // Directly, not behind queued events: a publish stuck mid-handshake must
    // not hold up the stop.
    await this.endSession();
    this.emit("stopped", undefined);
  }

  /** Hold the event stream open, reconnecting with backoff, until aborted. */
  private async listen(secret: string, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const res = await fetch(this.url("events"), {
          headers: { Authorization: `Bearer ${secret}`, Accept: "text/event-stream" },
          cache: "no-store",
          signal,
        });
        if (res.status === 401 || res.status === 403) {
          // Retrying cannot help. A 401 means the secret itself is dead
          // (revoked or unknown), so drop it and let enrollIfNeeded() take a
          // new code; a 403 is a refusal the stored secret may outlive.
          if (res.status === 401) await this.credentials.clear();
          this.emit("error", await responseError(res));
          void this.stop();
          return;
        }
        if (!res.ok || !res.body) throw await responseError(res);
        failures = 0; // connected: the next drop starts the backoff over
        const feed = sseParser((data) => this.dispatch(data));
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          feed(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        if (signal.aborted) return;
        // Once per outage, not once per reconnect attempt.
        if (e instanceof MebiusError && failures === 0) this.emit("error", e);
      }
      // The engine ends a session whose device dropped off.
      this.enqueue(() => this.endSession());
      await new Promise((r) => setTimeout(r, reconnectDelayMs(failures++)));
    }
  }

  private dispatch(data: string): void {
    let ev: AgentEvent;
    try {
      ev = JSON.parse(data) as AgentEvent;
    } catch {
      return;
    }
    if (typeof ev !== "object" || ev === null || typeof ev.type !== "string") return;
    this.enqueue(() => this.handle(ev));
  }

  /** Chain `fn` behind earlier events. A link that throws is reported and never blocks the next. */
  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((e: unknown) => {
      this.emit("error", e instanceof MebiusError ? e : mebiusError("UNKNOWN", undefined, e));
    });
  }

  private async handle(ev: AgentEvent): Promise<void> {
    if (ev.type === "session.stop") {
      if (this.session?.id === ev.sessionId) await this.endSession();
      return;
    }
    if (
      ev.type !== "session.start" ||
      typeof ev.sessionId !== "string" ||
      typeof ev.publishToken !== "string"
    )
      return;
    await this.endSession();
    if (!this.source) return;
    // Before publishing, so the user is told as soon as someone is watching.
    this.emit("viewing", { sessionId: ev.sessionId, mode: ev.mode, userId: ev.userId ?? "" });
    const broadcaster = new MebiusBroadcaster(
      new SignalingClient(this.gateway, ev.publishToken),
      { source: this.source, maxBitrateKbps: ev.maxBitrateKbps },
      null,
      undefined,
      ev.iceServers,
    );
    this.session = { id: ev.sessionId, broadcaster };
    try {
      await broadcaster.start(ev.sessionId);
    } catch (e) {
      if (this.session?.broadcaster !== broadcaster) return; // stopped meanwhile
      this.emit(
        "error",
        e instanceof MebiusError ? e : mebiusError("CONNECTION_FAILED", undefined, e),
      );
      await this.endSession();
    }
  }

  private async endSession(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    await session.broadcaster.stop().catch(() => undefined);
    this.emit("ended", { sessionId: session.id });
  }
}
