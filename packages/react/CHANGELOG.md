# @mebius-io/react

## 0.7.0

### Minor Changes

- Keep a session alive past its token, and stop trading smoothness for latency nobody asked for.

  **`getToken` — sessions that outlive one token.** A connection used to live exactly as long as the token it was opened with: the gateway checks that token on every media request, so playback stopped at expiry no matter how healthy the stream was. Fine for a short watch, wrong for anything unattended. Pass `getToken` to `Mebius.connect` (or `useMebius`) and Mebius mints ahead of expiry, retrying with backoff while the old token is still valid, and emits `token-refreshed`. Without it, behaviour is unchanged.

  Refreshing reaches the segmented route too, which is the half a token swap cannot do on its own: that route hands one URL to the media library and never speaks to it again, so requests are re-stamped with the current token as they are made. Only an existing token parameter is replaced, never added — an edge-served URL carries the edge's own signature and must not receive ours.

  **`targetLatencyMs` — buy a steady picture with a little delay.** Video that has arrived but is not yet shown is what absorbs an unsteady network: a late or re-sent piece still lands before its turn and the viewer sees nothing. With no cushion the same event freezes the picture, and the freeze is not brief — video resumes only at the next complete frame, a second or two later. Small buffers therefore produce long stalls, not small ones. Defaults to ~300ms on the real-time route (conversation still feels immediate); set 1500-3000 for watching. Honoured by whichever route serves the viewer, so a failover cannot silently change the trade.

  The buffered route no longer corrects drift by jumping the playhead. It jumped to 0.4s behind the newest data whenever the buffer grew past 2s — destroying the cushion every time it recovered, and the jump was a visible stutter of its own. Drift is now corrected by playing 2-5% fast or slow, inaudibly, and a jump is reserved for a gap speed could not close.

  **Playback statistics that measure what viewers feel.** A frozen real-time picture reports a healthy connection and raises no event on the video element, so every freeze on that route was recorded as zero — sessions looked flawless over a still frame. That route now measures its own freezes, and reports round-trip time, packet loss and the delay actually being lived with, each as the difference between readings rather than a running total. Inbound bitrate is now the bitrate actually received; it previously reported estimated available bandwidth.

### Patch Changes

- Updated dependencies
  - @mebius-io/web@0.7.0

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

- Updated dependencies
  - @mebius-io/web@0.6.2

## 0.4.6

### Patch Changes

- Bumped to pick up @mebius-io/web 0.4.6. The dependency is an exact pin.

## 0.4.5

### Patch Changes

- Bumped to pick up @mebius-io/web 0.4.5. The dependency is an exact pin.

## 0.4.4

### Patch Changes

- Bumped to pick up @mebius-io/web 0.4.4, where `setVolume` above zero also
  unmutes. The dependency is an exact pin.

## 0.4.3

### Patch Changes

- Bumped to pick up @mebius-io/web 0.4.3, which closes the buffering/playing
  event pair and stops a second player from orphaning the first on the same
  element. The dependency is an exact pin.

## 0.4.2

### Patch Changes

- Bumped to pick up @mebius-io/web 0.4.2, which makes a browser broadcast
  watchable outside the real-time route and cuts join delay on the buffered
  ones. The dependency is an exact pin, so 0.4.1 of this package would keep
  resolving to the previous web build.

## 0.4.1

### Patch Changes

- Picks up the playback fixes in `@mebius-io/web` 0.4.1 (autoplay policy handled
  instead of swallowed, so a live stream renders instead of showing a black
  element). No API change here; the dependency pin is exact, so this release is
  what carries the fix to consumers of this package.

## 0.4.0

### Minor Changes

- `useMebius({ ..., beaconToken, beaconUrl, userId })` forwards the quality
  reporting credential to `@mebius-io/web`, so hooks-based apps show up in the
  Mebius dashboard and have their viewer minutes counted.

  Take all three from the same token response that already gives you `deliveries`.
  Optional: without them the stream behaves identically, you just see no quality
  data. Safe in a client — the credential is bound by signed claims to one stream
  and one project.

  Changing `beaconToken` or `beaconUrl` reconnects the client, the same way a
  changing `token` does.

## 0.3.0

### Minor Changes

- `useMebius({ ..., deliveries })` forwards the gateway's delivery list to
  `@mebius-io/web`, so hooks-based apps get edge playback and the automatic
  route fallback that ships in web 0.3.0.

  Keep the array reference stable (memoize it) — a new array identity on every
  render reconnects the client, the same way a changing `token` does.

  `usePlayer(client, {})` is now valid: `mode` is optional and defaults to
  `"auto"`.

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

### Patch Changes

- Updated dependencies
  - @mebius-io/web@0.2.0

## 0.1.3

### Patch Changes

- Harden transport abstraction: neutralize internal signaling vocabulary so no protocol terms (whip/whep/hls/flv/mpegts/rtmp/srt/m3u8/sdp) leak into the client-facing surface (published .d.ts + README). Strengthen the abstraction guard to catch lowercase variants and additional protocol tokens. Runtime gateway paths stay internal.
- Updated dependencies
  - @mebius-io/web@0.1.3

## 0.1.2

### Patch Changes

- Docs: simplify @mebius-io/react install to a single `npm i @mebius-io/react` (dependency @mebius-io/web + peer react auto-resolve from the registry); the two-tarball step applies only to offline installs.
- Updated dependencies
  - @mebius-io/web@0.1.2

## 0.1.1

### Patch Changes

- Align the gateway contract with mebius-stream-engine: pass the access token via the `?token=` query parameter (the form the engine enforces) and serve scale playback from `/live/{streamId}/index.m3u8`. Refresh package READMEs now that the packages are published to the npm registry (`npm i @mebius-io/*`); tarball is documented as the offline-only path.
- Updated dependencies
  - @mebius-io/web@0.1.1
