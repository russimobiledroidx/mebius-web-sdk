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

const STORAGE_KEY = "mebius.screen.device";

/**
 * The default store: this browser's `localStorage`. Every access is guarded,
 * since storage can be disabled or full; a browser that cannot keep the
 * credentials simply enrolls again next time.
 */
const localCredentials: ScreenCredentialStore = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as ScreenCredentials) : null;
    } catch {
      return null;
    }
  },
  save(credentials) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
    } catch {
      /* see above */
    }
  },
  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* see above */
    }
  },
};

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

  /** @internal */
  constructor(
    private readonly gateway: string,
    options: ScreenShareOptions = {},
  ) {
    super();
    this.credentials = options.credentials ?? localCredentials;
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
    const { deviceId, deviceSecret } = (await res.json()) as ScreenCredentials;
    await this.credentials.save({ deviceId, deviceSecret });
  }

  /**
   * Ask the user which screen to share, then put this device online. Call it
   * straight from a click handler: the browser only shows its picker in
   * response to a user gesture.
   */
  async start(): Promise<void> {
    if (this.source) return;
    let source: MediaStream;
    try {
      // First, before anything else is awaited: an await in between spends the
      // click, and the browser refuses the picker.
      source = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (cause) {
      throw mebiusError("PERMISSION_DENIED", "Screen sharing was not allowed.", cause);
    }
    const credentials = await this.credentials.load();
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
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    this.abort?.abort();
    this.abort = null;
    await (this.queue = this.queue.then(() => this.endSession()));
    source.getTracks().forEach((t) => t.stop());
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
          // Revoked or unknown: retrying cannot help, and the stored secret is
          // dead, so drop it and let enrollIfNeeded() take a new code.
          await this.credentials.clear();
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
        if (e instanceof MebiusError) this.emit("error", e);
      }
      // The engine ends a session whose device dropped off.
      this.queue = this.queue.then(() => this.endSession());
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
    this.queue = this.queue.then(() => this.handle(ev));
  }

  private async handle(ev: AgentEvent): Promise<void> {
    if (ev.type === "session.stop") {
      if (this.session?.id === ev.sessionId) await this.endSession();
      return;
    }
    if (ev.type !== "session.start" || !this.source) return;
    await this.endSession();
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
