# @mebius-io/react

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
