/**
 * INTERNAL — the screen-share wire contract (mebius-stream-engine PR #53):
 * where a pointer lands on the shared screen, how input batches reach
 * `POST /api/v1/screen/sessions/:id/input`, and how the agent's event stream
 * (`GET /api/v1/screen/agent/events`, Server-Sent Events) is read.
 */
import { mebiusError, type MebiusError } from "../errors.js";

/** One input event, exactly as the engine accepts it. */
export type ScreenInputEvent =
  | { type: "move"; x: number; y: number }
  | { type: "down" | "up"; x: number; y: number; button: "left" | "middle" | "right" }
  | { type: "wheel"; dx: number; dy: number }
  | { type: "keydown" | "keyup"; key: string };

/** The engine's per-request ceiling. */
export const MAX_INPUT_BATCH = 64;

/**
 * Least time between two input requests. The engine allows 3600 a minute per
 * session; frames alone would exceed that on a 120 Hz display.
 */
export const MIN_INPUT_INTERVAL_MS = 20;

/** Retries of a rate-limited batch, and the delay before the first. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 250;

/** The engine's ceiling on one wheel delta. */
export const MAX_WHEEL_DELTA = 10_000;

/**
 * Where a client point falls on the shared screen, as fractions 0..1 of the
 * picture itself — not of the element, which also holds the bars `object-fit`
 * leaves around a picture whose shape differs from it.
 *
 * `inside` is false over those bars or outside the element; x/y are then
 * clamped to the nearest edge, so a drag that leaves the picture still ends
 * where it left. `null` while the element has no picture yet.
 *
 * ponytail: assumes the default `object-position` (centred) and no padding on
 * the element; honour both here if an app styles the video that way.
 */
export function screenPoint(
  box: { left: number; top: number; width: number; height: number },
  videoWidth: number,
  videoHeight: number,
  objectFit: string,
  clientX: number,
  clientY: number,
): { x: number; y: number; inside: boolean } | null {
  if (!videoWidth || !videoHeight || !box.width || !box.height) return null;
  const sx = box.width / videoWidth;
  const sy = box.height / videoHeight;
  let w = box.width;
  let h = box.height;
  if (objectFit !== "fill") {
    const contain = Math.min(sx, sy);
    const scale =
      objectFit === "cover"
        ? Math.max(sx, sy)
        : objectFit === "none"
          ? 1
          : objectFit === "scale-down"
            ? Math.min(1, contain)
            : contain; // "contain" is a video element's default
    w = videoWidth * scale;
    h = videoHeight * scale;
  }
  const rx = (clientX - box.left - (box.width - w) / 2) / w;
  const ry = (clientY - box.top - (box.height - h) / 2) / h;
  const x = Math.min(1, Math.max(0, rx));
  const y = Math.min(1, Math.max(0, ry));
  return { x, y, inside: x === rx && y === ry };
}

/** A Mebius error for a failed screen API response, keeping the engine's own message. */
export async function responseError(res: Response): Promise<MebiusError> {
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  const message = typeof body?.message === "string" && body.message ? body.message : undefined;
  if (res.status === 401) return mebiusError("TOKEN_EXPIRED", message);
  if (res.status === 403) return mebiusError("PERMISSION_DENIED", message);
  if (res.status === 404) return mebiusError("STREAM_NOT_FOUND", message);
  return mebiusError("CONNECTION_FAILED", message ?? `Mebius returned ${res.status}.`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nextFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(cb);
  else setTimeout(cb, 16);
}

/**
 * Sends input in per-frame batches of at most {@link MAX_INPUT_BATCH}, in
 * order, one request at a time. Consecutive moves collapse into the latest:
 * only where the pointer ended up matters, and a fast mouse would otherwise
 * fill a batch with positions nobody will see.
 */
export class InputSender {
  private queue: ScreenInputEvent[] = [];
  private scheduled = false;
  private sending = false;
  private lastSentAt = 0;
  /** Set once a failure was reported, until a request succeeds: one report per outage. */
  private failing = false;

  constructor(
    private readonly url: string,
    private readonly token: () => string,
    /** Get a fresh token; resolves false when none could be had. */
    private readonly refresh: () => Promise<boolean>,
    private readonly onError: (e: MebiusError) => void,
    private readonly schedule: (cb: () => void) => void = nextFrame,
  ) {}

  push(ev: ScreenInputEvent): void {
    const last = this.queue[this.queue.length - 1];
    if (ev.type === "move" && last?.type === "move") this.queue[this.queue.length - 1] = ev;
    else this.queue.push(ev);
    // While a request is in flight the drain loop picks these up when it lands.
    if (this.scheduled || this.sending) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const wait = this.lastSentAt + MIN_INPUT_INTERVAL_MS - Date.now();
        if (wait > 0) await sleep(wait);
        await this.send(this.queue.splice(0, MAX_INPUT_BATCH));
      }
    } finally {
      this.sending = false;
    }
  }

  private async send(events: ScreenInputEvent[], attempt = 0, refreshed = false): Promise<void> {
    this.lastSentAt = Date.now();
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });
    } catch (cause) {
      this.fail(mebiusError("CONNECTION_FAILED", undefined, cause));
      return;
    }
    if (res.ok) {
      this.failing = false;
      return;
    }
    if (res.status === 401 && !refreshed && (await this.refresh()))
      return this.send(events, attempt, true);
    // Rate limited: the batch may hold a click or a key, so it is worth a
    // short wait. Any other failure drops it: a click replayed seconds late
    // lands on whatever the screen shows by then.
    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_DELAY_MS * (attempt + 1));
      return this.send(events, attempt + 1, refreshed);
    }
    this.fail(await responseError(res));
  }

  private fail(e: MebiusError): void {
    if (!this.failing) this.onError(e);
    this.failing = true;
  }
}

/**
 * Incremental Server-Sent Events parser. Feed it decoded text in whatever
 * chunks the network delivers; it calls `onData` once per complete event with
 * that event's `data` lines joined. Comments (`: ping`) and other fields are
 * skipped.
 */
export function sseParser(onData: (data: string) => void): (chunk: string) => void {
  let buffer = "";
  let data: string[] = [];
  return (chunk) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line === "") {
        if (data.length > 0) onData(data.join("\n"));
        data = [];
      } else if (line.startsWith("data:")) {
        data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
    }
  };
}

/**
 * Delay before reconnect attempt `attempt` (0-based): 1s, 2s, 4s … capped at
 * 30s, plus up to 20% jitter so a fleet of agents dropped by one engine
 * restart does not reconnect in lockstep.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return base + random() * base * 0.2;
}
