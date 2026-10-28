import { mebiusError, MebiusError } from "./errors.js";
import { TypedEmitter, type ScreenViewerEventMap } from "./events.js";
import { WhepViewTransport } from "./internal/ll-view-transport.js";
import { InputSender, MAX_WHEEL_DELTA, screenPoint } from "./internal/screen.js";
import { SignalingClient } from "./internal/signaling.js";
import { readToken } from "./internal/token.js";
import { resolveVideoElement } from "./internal/view-target.js";
import type { ScreenControlOptions, ScreenWatchOptions, ViewTarget } from "./types.js";

/**
 * Until the device starts sending its screen there is nothing to watch, and
 * that takes a few seconds after the session is created. Retry for that long
 * rather than failing the first attempt.
 */
const WATCH_RETRY_MS = 1000;
const WATCH_BUDGET_MS = 15_000;
/** An ICE `disconnected` gets this long to come back on its own before reconnecting. */
const DISCONNECT_GRACE_MS = 2000;
/** Renew the view token this long before it expires… */
const REFRESH_MARGIN_MS = 60_000;
/** …but never sooner than this, so a short-lived or skewed token cannot spin the timer. */
const MIN_REFRESH_DELAY_MS = 5000;

type Button = "left" | "middle" | "right";
/** `PointerEvent.buttons` bits. */
const BUTTON_BITS: readonly [number, Button][] = [
  [1, "left"],
  [2, "right"],
  [4, "middle"],
];

/** `deltaMode` lines and pages, in the pixels the engine expects. */
const WHEEL_UNIT = [1, 40, 800];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Watches one screen session and, in a `control` session, sends the viewer's
 * mouse and keyboard to the shared screen.
 *
 * Create one with {@link Mebius.createScreenViewer}.
 */
export class MebiusScreenViewer extends TypedEmitter<ScreenViewerEventMap> {
  private transport: WhepViewTransport | null = null;
  private signaling: SignalingClient | null = null;
  private video: HTMLVideoElement | null = null;
  private iceServers: RTCIceServer[] | undefined;
  private sessionId = "";
  private token = "";
  private closed = false;
  private reconnecting = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  private refreshToken: ScreenControlOptions["refreshToken"] | null = null;
  private refreshing: Promise<boolean> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private unbind: (() => void) | null = null;

  /** @internal */
  constructor(private readonly gateway: string) {
    super();
  }

  /**
   * Show the session's screen in `target`. Resolves once Mebius has accepted
   * this viewer (the picture follows within moments); rejects if that did not
   * happen within about 15 seconds, or at once if the token was refused.
   *
   * A connection lost later is reopened on its own. If Mebius refuses the
   * reopen (the session ended), `ended` is emitted and the viewer closes.
   */
  async watch(options: ScreenWatchOptions, target: ViewTarget): Promise<void> {
    if (this.closed) throw mebiusError("NOT_CONNECTED", "This screen viewer was closed.");
    this.video = resolveVideoElement(target);
    this.sessionId = options.sessionId;
    this.token = options.token;
    this.iceServers = options.iceServers;
    this.signaling = new SignalingClient(this.gateway, options.token);
    await this.connect(true);
  }

  /**
   * Open the picture, retrying inside the budget. `initial`: the device may not
   * be sending yet, so "not found" is retried; once watching, it means the
   * session is over.
   */
  private async connect(initial: boolean): Promise<void> {
    const deadline = Date.now() + WATCH_BUDGET_MS;
    for (;;) {
      const t = new WhepViewTransport(this.signaling!, undefined, this.iceServers);
      this.transport = t;
      try {
        await t.start(this.sessionId, this.video!);
      } catch (e) {
        await t.stop();
        if (this.closed) return;
        // The media server answers a refused handshake with 400,
        // not 401/403, whatever the auth hook said. Sending the same offer and
        // token again gets the same 400, so it is a refusal, not a hiccup.
        const status =
          e instanceof MebiusError
            ? (e.cause as { status?: number } | undefined)?.status
            : undefined;
        const refused =
          !(e instanceof MebiusError) ||
          e.code === "TOKEN_EXPIRED" ||
          status === 400 ||
          (!initial && e.code === "STREAM_NOT_FOUND");
        if (refused || Date.now() + WATCH_RETRY_MS > deadline) throw e;
        await sleep(WATCH_RETRY_MS);
        if (this.closed) return;
        continue;
      }
      // close() while the exchange was in flight: start() already left nothing attached.
      if (this.closed) return;
      t.onEnded(() => this.lost(t));
      t.onBuffering(() => {
        if (t.connectionState !== "disconnected") return this.lost(t);
        // ICE often recovers from a brief disconnect by itself.
        if (this.graceTimer) return;
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          if (t.connectionState !== "connected") this.lost(t);
        }, DISCONNECT_GRACE_MS);
      });
      return;
    }
  }

  /**
   * The picture's connection went away. Ask for it again: that tells a network
   * blip (accepted, watching resumes) from an ended session (refused).
   */
  private lost(t: WhepViewTransport): void {
    if (this.closed || this.reconnecting || this.transport !== t) return;
    this.reconnecting = true;
    void t.stop();
    this.connect(false).then(
      () => (this.reconnecting = false),
      () => this.end(),
    );
  }

  /**
   * Send this viewer's mouse, wheel and keyboard to the shared screen. Only a
   * session created with mode `control` accepts input.
   *
   * Keys are captured while the video element has focus (a click on it focuses
   * it), Tab and Escape included: they go to the shared screen. Click outside
   * the video to take the keyboard back.
   */
  enableControl(options: ScreenControlOptions): void {
    const video = this.video;
    if (!video || this.closed)
      throw mebiusError("NOT_CONNECTED", "Call watch() before enableControl().");
    this.disableControl();
    this.refreshToken = options.refreshToken;
    this.scheduleRefresh(null);
    const sender = new InputSender(
      `${this.gateway.replace(/\/+$/, "")}/api/v1/screen/sessions/${encodeURIComponent(this.sessionId)}/input`,
      () => this.token,
      () => this.renewToken(),
      (e) => {
        this.emit("error", e);
        // A view-only session never starts accepting input.
        if (e.code === "PERMISSION_DENIED") this.disableControl();
      },
    );

    const keys = new Set<string>();
    const buttons = new Set<Button>();
    let last: { x: number; y: number } | null = null;
    const point = (ev: MouseEvent) =>
      screenPoint(
        video.getBoundingClientRect(),
        video.videoWidth,
        video.videoHeight,
        getComputedStyle(video).objectFit,
        ev.clientX,
        ev.clientY,
      );
    /**
     * Bring the shared screen's buttons in line with `ev.buttons`. Driven by the
     * bitmask rather than `ev.button` because a second button pressed while one
     * is held arrives as a `pointermove`, not a `pointerdown`. A release is only
     * sent for a press that was sent, and a press only lands on the picture.
     */
    const sync = (ev: PointerEvent) => {
      const p = point(ev);
      if (p) last = { x: p.x, y: p.y };
      for (const [bit, button] of BUTTON_BITS) {
        const down = (ev.buttons & bit) !== 0;
        if (down && !buttons.has(button) && p?.inside) {
          buttons.add(button);
          sender.push({ type: "down", x: p.x, y: p.y, button });
        } else if (!down && buttons.has(button) && last) {
          buttons.delete(button);
          sender.push({ type: "up", ...last, button });
        }
      }
    };
    const releaseButtons = () => {
      if (last) for (const button of buttons) sender.push({ type: "up", ...last, button });
      buttons.clear();
    };
    const onMove = (ev: PointerEvent) => {
      const p = point(ev);
      if (p) sender.push({ type: "move", x: p.x, y: p.y });
      sync(ev);
    };
    const onDown = (ev: PointerEvent) => {
      ev.preventDefault();
      video.focus();
      // So the release still arrives when it happens outside the element.
      video.setPointerCapture?.(ev.pointerId);
      sync(ev);
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const unit = WHEEL_UNIT[ev.deltaMode] ?? 1;
      const clamp = (d: number) =>
        Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, Math.round(d * unit)));
      sender.push({ type: "wheel", dx: clamp(ev.deltaX), dy: clamp(ev.deltaY) });
    };
    // Keys still down when focus leaves would otherwise stay down on the
    // shared screen: their keyup goes to whatever has focus now.
    const releaseKeys = () => {
      for (const key of keys) sender.push({ type: "keyup", key });
      keys.clear();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.code) return;
      ev.preventDefault();
      if (ev.type === "keydown") {
        // The shared screen repeats a held key itself.
        if (ev.repeat || keys.has(ev.code)) return;
        keys.add(ev.code);
        sender.push({ type: "keydown", key: ev.code });
        return;
      }
      if (!keys.delete(ev.code)) return;
      sender.push({ type: "keyup", key: ev.code });
      // macOS fires no keyup for keys released while Meta was held.
      if (ev.code.startsWith("Meta")) releaseKeys();
    };
    const noMenu = (ev: Event) => ev.preventDefault();

    if (video.tabIndex < 0) video.tabIndex = 0;
    // Without this a touch drag pans the page and the browser cancels the pointer.
    const touchAction = video.style.touchAction;
    video.style.touchAction = "none";
    const listeners: [string, EventListener, AddEventListenerOptions?][] = [
      ["pointermove", onMove as EventListener],
      ["pointerdown", onDown as EventListener],
      ["pointerup", sync as EventListener],
      ["pointercancel", releaseButtons],
      ["wheel", onWheel as EventListener, { passive: false }],
      ["keydown", onKey as EventListener],
      ["keyup", onKey as EventListener],
      ["blur", releaseKeys],
      ["contextmenu", noMenu],
    ];
    for (const [type, fn, opts] of listeners) video.addEventListener(type, fn, opts);
    this.unbind = () => {
      releaseButtons();
      releaseKeys();
      video.style.touchAction = touchAction;
      for (const [type, fn] of listeners) video.removeEventListener(type, fn);
    };
  }

  /** Stop sending input, releasing anything still held. Watching continues. */
  disableControl(): void {
    this.unbind?.();
    this.unbind = null;
    this.refreshToken = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * Stop watching and release the video element. The session itself ends on
   * its own once nobody has watched it for 60 seconds, or when your backend
   * ends it.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disableControl();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    void this.transport?.stop();
    this.transport = null;
    this.removeAllListeners();
  }

  private end(): void {
    if (this.closed) return;
    this.emit("ended", undefined);
    this.close();
  }

  /**
   * Arm the next renewal. `previousExpMs`: the expiry the renewed token
   * replaced; a token that does not outlive it arms nothing, leaving renewal to
   * the next rejected request rather than asking again in a loop.
   */
  private scheduleRefresh(previousExpMs: number | null): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const { expiresAtMs } = readToken(this.token);
    if (expiresAtMs === null || !this.refreshToken) return;
    if (previousExpMs !== null && expiresAtMs <= previousExpMs) return;
    this.refreshTimer = setTimeout(
      () => void this.renewToken(),
      Math.max(MIN_REFRESH_DELAY_MS, expiresAtMs - Date.now() - REFRESH_MARGIN_MS),
    );
  }

  /** One refresh at a time, however many requests are waiting on it. */
  private renewToken(): Promise<boolean> {
    const refresh = this.refreshToken;
    if (!refresh) return Promise.resolve(false);
    if (!this.refreshing) {
      const p = this.fetchToken(refresh);
      this.refreshing = p;
      void p.finally(() => {
        if (this.refreshing === p) this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async fetchToken(refresh: ScreenControlOptions["refreshToken"]): Promise<boolean> {
    try {
      const next = await refresh();
      if (this.refreshToken !== refresh) return false; // control was disabled meanwhile
      const previous = readToken(this.token).expiresAtMs;
      this.token = next;
      this.signaling?.setToken(next);
      this.scheduleRefresh(previous);
      return true;
    } catch (cause) {
      this.emit(
        "error",
        mebiusError("TOKEN_EXPIRED", "Could not refresh the screen session token.", cause),
      );
      return false;
    }
  }
}
