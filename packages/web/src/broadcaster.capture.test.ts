import { afterEach, describe, expect, it, vi } from "vitest";
import { SignalingClient } from "./internal/signaling.js";
import { MebiusBroadcaster } from "./broadcaster.js";
import type { BroadcasterOptions } from "./types.js";

/**
 * 1080p capture is opt-in. An integrator on the default bitrate ceiling must get
 * the exact getUserMedia call it always got — on start and on camera switch.
 */

const HD = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };

function setup(options: BroadcasterOptions) {
  const track = { kind: "video", stop() {} };
  const stream = { getVideoTracks: () => [track], removeTrack() {}, addTrack() {} };
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const b = new MebiusBroadcaster(new SignalingClient("https://gateway.example", "tok"), options);
  const internals = b as unknown as {
    capture(): Promise<unknown>;
    stream: unknown;
    transport: { replaceVideoTrack(): Promise<void> };
  };
  internals.transport = { replaceVideoTrack: async () => undefined };
  return {
    getUserMedia,
    async captureAndSwitch() {
      internals.stream = await internals.capture();
      await b.switchCamera();
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("broadcaster capture constraints", () => {
  it.each([{}, { maxBitrateKbps: 2500 }, { maxBitrateKbps: 0 }])(
    "unchanged on the default ceiling (%o)",
    async (options) => {
      const { getUserMedia, captureAndSwitch } = setup(options);
      await captureAndSwitch();
      expect(getUserMedia.mock.calls).toEqual([
        [{ video: true, audio: true }],
        [{ video: { facingMode: "environment" }, audio: false }],
      ]);
    },
  );

  it("asks for ideal 1080p30 once the app opts into a ladder-source bitrate", async () => {
    const { getUserMedia, captureAndSwitch } = setup({ maxBitrateKbps: 5000 });
    await captureAndSwitch();
    expect(getUserMedia.mock.calls).toEqual([
      [{ video: HD, audio: true }],
      [{ video: { ...HD, facingMode: "environment" }, audio: false }],
    ]);
  });

  it("leaves the app's own constraints alone even when opted in", async () => {
    const own = { width: 640 };
    const { getUserMedia, captureAndSwitch } = setup({ maxBitrateKbps: 5000, video: own });
    await captureAndSwitch();
    expect(getUserMedia.mock.calls[0]).toEqual([{ video: own, audio: true }]);
  });
});
