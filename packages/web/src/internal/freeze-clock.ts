/**
 * INTERNAL — freeze-time accounting for playback telemetry.
 *
 * The dashboard's freeze ratio read 0.00% for every session ever recorded: the
 * player knew when playback stalled and when it resumed, and never subtracted
 * the two. A measured zero and an unmeasured zero look identical downstream, so
 * this is the difference between "playback was flawless" and "nobody looked".
 *
 * Split out of MebiusPlayer so the arithmetic — which is all edge cases — can
 * be tested without a DOM or a live stream.
 */
export class FreezeClock {
  /** When the current stall began, or null when playback is running. */
  private stalledSinceMs: number | null = null;
  /** Stall time that has ended but has not yet been shipped with a sample. */
  private pendingMs = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** True while a stall is in progress. */
  get stalled(): boolean {
    return this.stalledSinceMs !== null;
  }

  /**
   * Begin a stall. Re-entering while already stalled is ignored rather than
   * restarting the clock: flv.js fires `waiting` repeatedly through a single
   * long stall, and resetting the start on each would report a fraction of the
   * freeze that actually happened.
   */
  beginStall(): void {
    if (this.stalledSinceMs === null) this.stalledSinceMs = this.now();
  }

  /** End the current stall and bank its duration. No-op when not stalled. */
  endStall(): void {
    if (this.stalledSinceMs === null) return;
    this.pendingMs += Math.max(0, this.now() - this.stalledSinceMs);
    this.stalledSinceMs = null;
  }

  /**
   * Freeze milliseconds to report on this tick, resetting the counter.
   *
   * A stall still in progress is counted up to now and its clock restarted, so
   * a freeze longer than the sample interval is reported while it is happening
   * rather than landing whole in whichever sample eventually follows it. Every
   * millisecond is attributed exactly once — never dropped, never double-counted.
   */
  take(): number {
    if (this.stalledSinceMs !== null) {
      const now = this.now();
      this.pendingMs += Math.max(0, now - this.stalledSinceMs);
      this.stalledSinceMs = now;
    }
    const ms = this.pendingMs;
    this.pendingMs = 0;
    return ms;
  }

  /** Forget everything. Called when a session ends. */
  reset(): void {
    this.stalledSinceMs = null;
    this.pendingMs = 0;
  }
}
