/** INTERNAL — resolve a public {@link ViewTarget} to a real `<video>` element. */
import { mebiusError } from "../errors.js";
import type { ViewTarget } from "../types.js";

export function resolveVideoElement(target: ViewTarget): HTMLVideoElement {
  if (typeof target !== "string") {
    if (target instanceof HTMLVideoElement) return target;
    throw mebiusError("UNKNOWN", "View target must be a <video> element or a CSS selector.");
  }
  const el = document.querySelector(target);
  if (!el) {
    throw mebiusError("UNKNOWN", `No element matches the selector "${target}".`);
  }
  if (!(el instanceof HTMLVideoElement)) {
    throw mebiusError("UNKNOWN", `Selector "${target}" did not resolve to a <video> element.`);
  }
  return el;
}
