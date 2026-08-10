import { describe, expect, it } from "vitest";
import { retryWarmupNotFound } from "./scale-view-transport.js";

const cfg = { maxNumRetry: 5 };

describe("retryWarmupNotFound", () => {
  it("retries a 404 while the CDN edge is still warming up", () => {
    expect(retryWarmupNotFound(cfg, 0, { code: 404 }, false)).toBe(true);
  });

  it("stops retrying the 404 once the budget is spent", () => {
    expect(retryWarmupNotFound(cfg, 5, { code: 404 }, false)).toBe(false);
  });

  it("does not retry an auth failure", () => {
    expect(retryWarmupNotFound(cfg, 0, { code: 403 }, false)).toBe(false);
  });

  it("keeps hls.js's own decision when it already said retry", () => {
    expect(retryWarmupNotFound(cfg, 0, { code: 503 }, true)).toBe(true);
  });
});
