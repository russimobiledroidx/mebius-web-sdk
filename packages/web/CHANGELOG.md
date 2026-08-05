# @mebius-io/web

## 0.4.0

### Minor Changes

- Report stream quality, so it reaches your Mebius dashboard.

  Mebius shows per-stream publish/playback quality and derives viewer minutes from
  play-side reports, and only the client can see either — so both were empty until
  an SDK sent them.

  **`Mebius.connect()` takes `beaconToken` / `beaconUrl`** (and optionally
  `userId`), straight from the token response alongside `deliveries`. When present,
  the SDK samples the transport it already polls for the `stats` event and ships
  batches every 15s. Optional: without them the stream behaves identically, you
  just see no quality data.

  No tenant is ever configured or sent — attribution lives in the token's signed
  claims, which bind it to one stream and one project, so a credential in a browser
  can only report its own telemetry.

  Two details worth knowing: `pagehide` flushes via `sendBeacon`, because closing
  the tab IS how a viewing session normally ends and the last interval (and the
  watch time it represents) would otherwise be lost; and the player's first sample
  carries first-frame delay measured **across route attempts**, not from the
  accepted route, since a viewer who sat through a dead edge waited for it.

  Every telemetry failure is swallowed and never retried. It must not break a
  broadcast, and the next batch is 15s away carrying the same picture of health.

## 0.3.0

### Minor Changes

- Playback routes now come from the gateway, and a route that delivers no frames
  no longer means a black screen.

  **`Mebius.connect()` accepts `deliveries`.** Your backend already receives this
  list alongside the token; pass it through untouched. Mebius orders it and picks
  from it. Optional — without it playback still works, but every viewer is served
  from Mebius origin rather than the nearest edge.

  **New default mode `"auto"`.** `createPlayer()` no longer requires `mode`. In
  `"auto"` the gateway's ordering decides, so route policy changes without an SDK
  release.

  **First-frame watchdog.** A route can report a healthy connection and still send
  nothing: an edge with no ingest yet answers 200 with an empty stream, and a
  real-time connection reports `connected` while zero frames arrive. Every mode now
  walks an ordered candidate list and moves on if the picture has not advanced
  within 8s, instead of sitting on a dead route.

  **New `client.createMonitor()`.** A player for a stream you are interacting WITH
  (the other side of a co-broadcast), where a second of delay makes the interaction
  feel broken. Apps used to hand-roll this — open a real-time view, run a timer,
  swap players when it stayed black — and getting the fallback wrong put a black
  frame in front of a live audience.

  **`"balanced"` is back.** 0.2.0 removed it, on the reading that the gateway
  served no route for it. That reading was wrong: the route had simply not been
  built, and mid-latency playback is what production web viewing has always used.
  The gateway serves it now. The library that plays it is a bundled `dependency`,
  never a `peerDependency` — an integrator must never have to type a transport
  library's name to make Mebius work.

  Nothing breaks: `mode` is now optional (previously required), `deliveries` is
  optional, and every existing mode value still resolves. Callers that pass no
  `deliveries` keep the origin playlist they use today.

  Note: the single-file drop-in build grows from ~520 KB to ~675 KB minified,
  because the mid-latency player is inlined into it. The npm packages are
  unaffected — there each playback engine is still loaded lazily, only when the
  mode that needs it is used.

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
