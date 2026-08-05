/**
 * INTERNAL — getting a `<video>` element to actually render.
 *
 * Every transport used to call `video.play().catch(() => undefined)`. That hides
 * the single most common playback failure in a browser: Chrome and Safari refuse
 * to start playback WITH AUDIO unless the page has sticky user activation. The
 * promise rejects with NotAllowedError, the element stays on frame zero, and the
 * SDK reports nothing — so a stream that is serving perfectly looks dead, the
 * first-frame watchdog times out on every route in turn, and the whole thing
 * surfaces as "no fallback, black video" even though the fallback ran.
 *
 * A click is not enough on its own: activation is consumed and expires, and a
 * play() that happens after `await fetchToken()` and `await import("hls.js")` is
 * often too late.
 *
 * Muted playback is always allowed. So: try with sound, and if the policy
 * refuses, mute and try again — a muted picture the viewer can unmute beats a
 * black rectangle. The caller learns which happened instead of nothing at all.
 */

export interface PlayOutcome {
  /** True when playback started only because we muted the element. */
  mutedByPolicy: boolean;
}

/** Is this the browser's autoplay policy talking, rather than a real failure? */
function isAutoplayBlocked(e: unknown): boolean {
  // Chrome/Safari/Firefox all use NotAllowedError here. The name check is the
  // portable signal; message text is not.
  return typeof e === "object" && e !== null && (e as { name?: string }).name === "NotAllowedError";
}

/**
 * Start playback, retrying muted if the autoplay policy blocks sound.
 *
 * Rethrows anything that is NOT a policy refusal: an unsupported source or a
 * decode failure is exactly what the player's route-fallback exists for, and
 * swallowing it made a dead route indistinguishable from a slow one.
 */
export async function playWithAutoplayFallback(video: HTMLVideoElement): Promise<PlayOutcome> {
  // Set both here rather than relying on the app's markup: inline playback on
  // iOS is refused outright without playsInline, whatever the policy says.
  video.playsInline = true;
  try {
    await video.play();
    return { mutedByPolicy: false };
  } catch (e) {
    if (!isAutoplayBlocked(e) || video.muted) throw e;
    video.muted = true;
    await video.play();
    return { mutedByPolicy: true };
  }
}

/**
 * Return a video element to a clean state before a different transport attaches
 * to it.
 *
 * `srcObject` and `src` are not interchangeable slots: while srcObject is set,
 * the element IGNORES src entirely. So a real-time route that attached a
 * MediaStream and then failed would silently block the HLS route behind it from
 * ever showing a frame — the picture stays black while every log says the
 * playlist loaded fine.
 */
export function resetVideoElement(video: HTMLVideoElement): void {
  video.srcObject = null;
  video.removeAttribute("src");
  video.load();
}
