/** INTERNAL — small WebRTC helpers shared by publish/view transports. */

/**
 * Wait until ICE gathering completes (or a short timeout elapses) so the SDP
 * we send already contains candidates. Keeps the gateway exchange to a single
 * round-trip.
 */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/** Default ICE configuration. The gateway may also relay; STUN aids direct paths. */
export const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/**
 * The default configuration plus relay servers handed to us for one session.
 *
 * Added to the default STUN, never replacing it: a direct path is still tried
 * first, and the relay only carries the media when nothing direct gets through.
 * Without extra servers this is exactly {@link DEFAULT_RTC_CONFIG}.
 */
export function rtcConfig(extra?: readonly RTCIceServer[]): RTCConfiguration {
  if (!extra?.length) return DEFAULT_RTC_CONFIG;
  return { iceServers: [...(DEFAULT_RTC_CONFIG.iceServers ?? []), ...extra] };
}
