# @mebius-io/react-native

## 0.4.4

### Patch Changes

- Version alignment with @mebius-io/web 0.4.4. No change to this package.

## 0.4.3

### Patch Changes

- Version alignment with @mebius-io/web 0.4.3. No change to this package.

## 0.4.2

### Patch Changes

- Publish H264 instead of VP8.

  Same defect the web SDK carried: libwebrtc offers VP8 first, and the server's
  HLS/FLV/CDN muxers cannot carry it — they drop the video track, so a broadcast
  reaches every viewer outside the real-time route as audio only, while the
  device shows a healthy preview and bitrate throughout.

  Best-effort: `RTCRtpSender.getCapabilities` and `setCodecPreferences` both
  arrived in react-native-webrtc 111. On an older host they are absent and
  negotiation keeps its previous order.

## 0.4.1

### Patch Changes

- Picks up the playback fixes in `@mebius-io/web` 0.4.1 (autoplay policy handled
  instead of swallowed, so a live stream renders instead of showing a black
  element). No API change here; the dependency pin is exact, so this release is
  what carries the fix to consumers of this package.

## 0.4.0

### Minor Changes

- `Mebius.connect({ ..., beaconToken, beaconUrl, userId })` reports that a session
  is alive, so React Native viewers stop being counted as zero.

  Mebius derives viewer minutes from client reports: the span between a session's
  first and last sample IS the watch time. Until now a React Native viewer could
  watch for an hour and appear nowhere.

  Presence is reported every 15s, immediately on start (a viewer who leaves inside
  the first interval still watched), and once more on stop so the reported span
  reaches the moment of leaving.

  **No quality metrics on this platform yet.** This package has no stats surface —
  the native bridge exposes no `getStats` and nothing emits a `stats` event — so
  there are no real bitrate/fps/rtt numbers to send, and inventing them would put
  fiction in a dashboard people bill from. The quality columns stay honestly empty;
  watch time does not.

  Failures are swallowed and never retried: telemetry must not break a broadcast,
  and the next heartbeat is 15s away carrying the same information.

## 0.3.0

### Minor Changes

- Fix playlist playback, which could not have worked, and accept the gateway's
  delivery list.

  **Bug fixed:** `mode: "scale"` built a URL under a path prefix the gateway has
  never routed or allowlisted, and attached no access token — so it could only ever
  return 404 or 401. Playlist playback now uses the gateway's own `deliveries` list,
  falls back to the origin playlist the gateway does route, and always carries the
  token the playback gate requires.

  **`Mebius.connect()` accepts `deliveries`.** Pass through what your backend
  returned with the token. On mobile this is not a nicety: without it every viewer
  is served from Mebius origin, which is billed per viewer, instead of from an edge,
  which is not.

  **New default mode `"auto"`**, so `createPlayer()` no longer requires `mode`, and
  **new `client.createMonitor()`** for watching the other side of a co-broadcast.

  `"balanced"` is deliberately NOT offered here: it needs Media Source Extensions,
  which React Native has no equivalent of, so declaring it would repeat exactly the
  mistake 0.2.0 was fixing — a mode that can never play.

  **Bridge contract change** (relevant only if you implement `MebiusNativeBridge`
  yourself): `connect(token, deliveries?)` takes a second argument. Existing
  implementations keep working; they will just ignore the list and stay on origin.

## 0.2.0

### Minor Changes

- Remove the mid-latency playback mode and the vendor-named peer dependency.

  **Breaking:** `PlaybackMode` no longer accepts `"balanced"`. Published versions
  0.1.0–0.1.3 declared and documented that mode, but the gateway serves no route for
  it — the transport requested a path that is neither mounted nor present in the
  public allowlist, so every player using `mode: "balanced"` failed on its first
  request. It is removed rather than left as a broken promise in the public type.

  Migrate: use `"scale"` (plays everywhere, including iOS Safari) or
  `"low-latency"` (sub-second, browser only).

  **Also removed:** the optional `flv.js` peer dependency. It existed only to serve
  the mode above, and naming a transport library in `peerDependencies` told
  integrators which delivery protocol sits underneath — the SDK is supposed to keep
  that internal. Nothing to do on upgrade; if you installed `flv.js` solely for this
  SDK you can drop it.

  The abstraction guard now also scans the repository root (the npm landing README)
  and `package.json` peer dependencies, so neither class of leak can return
  unnoticed.

## 0.1.3

### Patch Changes

- Harden transport abstraction: neutralize internal signaling vocabulary so no protocol terms (whip/whep/hls/flv/mpegts/rtmp/srt/m3u8/sdp) leak into the client-facing surface (published .d.ts + README). Strengthen the abstraction guard to catch lowercase variants and additional protocol tokens. Runtime gateway paths stay internal.

## 0.1.2

### Patch Changes

- Docs: simplify @mebius-io/react install to a single `npm i @mebius-io/react` (dependency @mebius-io/web + peer react auto-resolve from the registry); the two-tarball step applies only to offline installs.

## 0.1.1

### Patch Changes

- Align the gateway contract with mebius-stream-engine: pass the access token via the `?token=` query parameter (the form the engine enforces) and serve scale playback from `/live/{streamId}/index.m3u8`. Refresh package READMEs now that the packages are published to the npm registry (`npm i @mebius-io/*`); tarball is documented as the offline-only path.
