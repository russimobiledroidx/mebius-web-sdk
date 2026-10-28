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
/** A dropped connection that has not come back after this long is over. */
const LOST_GRACE_MS = 3000;
/** Renew the view token this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;

const BUTTONS = ["left", "middle", "right"] as const;

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
  private sessionId = "";
  private token = "";
  private closed = false;
  private lostTimer: ReturnType<typeof setTimeout> | null = null;

  private refreshToken: ScreenControlOptions["refreshToken"] | null = null;
  private refreshing: Promise<boolean> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private unbind: (() => void) | null = null;

  /** @internal */
  constructor(private readonly gateway: string) {
    super();
  }

  /**
   * Show the session's screen in `target`. Resolves once the picture is
   * connected; rejects if it could not be within about 15 seconds.
   */
  async watch(options: ScreenWatchOptions, target: ViewTarget): Promise<void> {
    if (this.closed) throw mebiusError("NOT_CONNECTED", "This screen viewer was closed.");
    const video = resolveVideoElement(target);
    this.video = video;
    this.sessionId = options.sessionId;
    this.token = options.token;
    this.signaling = new SignalingClient(this.gateway, options.token);
    const deadline = Date.now() + WATCH_BUDGET_MS;
    for (;;) {
      const t = new WhepViewTransport(this.signaling, undefined, options.iceServers);
      this.transport = t;
      try {
        await t.start(options.sessionId, video);
        break;
      } catch (e) {
        await t.stop();
        if (this.closed) return;
        const retryable = e instanceof MebiusError && e.code !== "TOKEN_EXPIRED";
        if (!retryable || Date.now() + WATCH_RETRY_MS > deadline) throw e;
        await sleep(WATCH_RETRY_MS);
        if (this.closed) return;
      }
    }
    const t = this.transport;
    t.onEnded(() => this.end());
    t.onBuffering(() => {
      if (this.lostTimer) return;
      this.lostTimer = setTimeout(() => {
        this.lostTimer = null;
        if (this.transport === t && t.connectionState !== "connected") this.end();
      }, LOST_GRACE_MS);
    });
  }

  /**
   * Send this viewer's mouse, wheel and keyboard to the shared screen. Only a
   * session created with mode `control` accepts input. Keys are captured while
   * the video element has focus (a click on it focuses it).
   */
  enableControl(options: ScreenControlOptions): void {
    const video = this.video;
    if (!video || this.closed)
      throw mebiusError("NOT_CONNECTED", "Call watch() before enableControl().");
    this.disableControl();
    this.refreshToken = options.refreshToken;
    this.scheduleRefresh();
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

    const held = new Set<string>();
    const point = (ev: MouseEvent) =>
      screenPoint(
        video.getBoundingClientRect(),
        video.videoWidth,
        video.videoHeight,
        getComputedStyle(video).objectFit,
        ev.clientX,
        ev.clientY,
      );
    const onMove = (ev: PointerEvent) => {
      const p = point(ev);
      if (p) sender.push({ type: "move", x: p.x, y: p.y });
    };
    const onDown = (ev: PointerEvent) => {
      const p = point(ev);
      const button = BUTTONS[ev.button];
      // A press on the bars around the picture is not a press on the screen.
      if (!p?.inside || !button) return;
      ev.preventDefault();
      video.focus();
      // So the release still arrives when it happens outside the element.
      video.setPointerCapture?.(ev.pointerId);
      sender.push({ type: "down", x: p.x, y: p.y, button });
    };
    const onUp = (ev: PointerEvent) => {
      const p = point(ev);
      const button = BUTTONS[ev.button];
      if (p && button) sender.push({ type: "up", x: p.x, y: p.y, button });
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const unit = WHEEL_UNIT[ev.deltaMode] ?? 1;
      const clamp = (d: number) =>
        Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, Math.round(d * unit)));
      sender.push({ type: "wheel", dx: clamp(ev.deltaX), dy: clamp(ev.deltaY) });
    };
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.code) return;
      ev.preventDefault();
      if (ev.type === "keydown") held.add(ev.code);
      else held.delete(ev.code);
      sender.push({ type: ev.type === "keydown" ? "keydown" : "keyup", key: ev.code });
    };
    // Keys still down when focus leaves would otherwise stay down on the
    // shared screen: their keyup goes to whatever has focus now.
    const releaseKeys = () => {
      for (const key of held) sender.push({ type: "keyup", key });
      held.clear();
    };
    const noMenu = (ev: Event) => ev.preventDefault();

    if (video.tabIndex < 0) video.tabIndex = 0;
    video.addEventListener("pointermove", onMove);
    video.addEventListener("pointerdown", onDown);
    video.addEventListener("pointerup", onUp);
    video.addEventListener("wheel", onWheel, { passive: false });
    video.addEventListener("keydown", onKey);
    video.addEventListener("keyup", onKey);
    video.addEventListener("blur", releaseKeys);
    video.addEventListener("contextmenu", noMenu);
    this.unbind = () => {
      releaseKeys();
      video.removeEventListener("pointermove", onMove);
      video.removeEventListener("pointerdown", onDown);
      video.removeEventListener("pointerup", onUp);
      video.removeEventListener("wheel", onWheel);
      video.removeEventListener("keydown", onKey);
      video.removeEventListener("keyup", onKey);
      video.removeEventListener("blur", releaseKeys);
      video.removeEventListener("contextmenu", noMenu);
    };
  }

  /** Stop sending input. Watching continues. */
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
    if (this.lostTimer) clearTimeout(this.lostTimer);
    void this.transport?.stop();
    this.transport = null;
    this.removeAllListeners();
  }

  private end(): void {
    if (this.closed) return;
    this.emit("ended", undefined);
    this.close();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const { expiresAtMs } = readToken(this.token);
    if (expiresAtMs === null || !this.refreshToken) return;
    this.refreshTimer = setTimeout(
      () => void this.renewToken(),
      Math.max(0, expiresAtMs - Date.now() - REFRESH_MARGIN_MS),
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
      this.token = next;
      this.signaling?.setToken(next);
      this.scheduleRefresh();
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
