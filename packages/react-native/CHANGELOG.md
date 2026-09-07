# @mebius-io/react-native

## 0.7.0

### Minor Changes

- Keep a session alive past its token, and stop trading smoothness for latency nobody asked for.

  **`getToken` — sessions that outlive one token.** A connection used to live exactly as long as the token it was opened with: the gateway checks that token on every media request, so playback stopped at expiry no matter how healthy the stream was. Fine for a short watch, wrong for anything unattended. Pass `getToken` to `Mebius.connect` (or `useMebius`) and Mebius mints ahead of expiry, retrying with backoff while the old token is still valid, and emits `token-refreshed`. Without it, behaviour is unchanged.

  Refreshing reaches the segmented route too, which is the half a token swap cannot do on its own: that route hands one URL to the media library and never speaks to it again, so requests are re-stamped with the current token as they are made. Only an existing token parameter is replaced, never added — an edge-served URL carries the edge's own signature and must not receive ours.

  **`targetLatencyMs` — buy a steady picture with a little delay.** Video that has arrived but is not yet shown is what absorbs an unsteady network: a late or re-sent piece still lands before its turn and the viewer sees nothing. With no cushion the same event freezes the picture, and the freeze is not brief — video resumes only at the next complete frame, a second or two later. Small buffers therefore produce long stalls, not small ones. Defaults to ~300ms on the real-time route (conversation still feels immediate); set 1500-3000 for watching. Honoured by whichever route serves the viewer, so a failover cannot silently change the trade.

  The buffered route no longer corrects drift by jumping the playhead. It jumped to 0.4s behind the newest data whenever the buffer grew past 2s — destroying the cushion every time it recovered, and the jump was a visible stutter of its own. Drift is now corrected by playing 2-5% fast or slow, inaudibly, and a jump is reserved for a gap speed could not close.

  **Playback statistics that measure what viewers feel.** A frozen real-time picture reports a healthy connection and raises no event on the video element, so every freeze on that route was recorded as zero — sessions looked flawless over a still frame. That route now measures its own freezes, and reports round-trip time, packet loss and the delay actually being lived with, each as the difference between readings rather than a running total. Inbound bitrate is now the bitrate actually received; it previously reported estimated available bandwidth.

## 0.6.2

### Patch Changes

- Release the three packages together again, and stop pinning `@mebius-io/web` to
  one exact version from `@mebius-io/react`.

  The packages are declared a `fixed` group, which means changesets releases them
  at one shared version. Nothing had run `changeset version` since the repo was
  scaffolded — versions were hand-edited in feature commits instead — so the group
  drifted to 0.6.1 / 0.5.0 / 0.4.6.

  The drift was not cosmetic. `@mebius-io/react` depended on `@mebius-io/web`
  through `workspace:*`, which pnpm publishes as an exact version rather than a
  range, so `@mebius-io/react@0.5.0` required exactly `@mebius-io/web@0.5.0` and no
  consumer could upgrade past it. That is the release which introduced
  `useCaptions`, and 0.5.0 is the one web version where captions cannot work:
  `captionsUrl()` targeted the media-edge catch-all instead of the versioned
  control API, so every caption subscription answered 401. The fix shipped in web
  0.5.1 and five more caption fixes followed, none of which a React consumer could
  reach.

  The dependency is now `workspace:^`, published as a caret range, so a patch to
  `@mebius-io/web` reaches React consumers without a new `@mebius-io/react`.

  `@mebius-io/react-native` has no code change here. It carries no dependency on
  `@mebius-io/web` and no captions support; it moves only because the fixed group
  moves.

## 0.4.6

### Patch Changes

- Version alignment with @mebius-io/web 0.4.6. No change to this package.

## 0.4.5

### Patch Changes

- Version alignment with @mebius-io/web 0.4.5. No change to this package.

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
