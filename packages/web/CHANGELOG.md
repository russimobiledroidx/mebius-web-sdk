# @mebius-io/web

## 0.4.5

### Patch Changes

- The audio-less FLV retry no longer costs audio on a slow start, and a failed
  play() releases the element.

  0.4.3 added a recovery for an FLV header that claims audio the stream does not
  carry: no frame within 2.5s, retry without audio. "No frame" is also what a
  cold CDN edge looks like, and the retry is one-way — a stream that simply
  started slowly played perfectly and silently for the rest of the session.
  Observed once in testing. The retry now also requires that media has actually
  landed (`buffered` non-empty with the clock still at zero), which is the real
  signature of a track that will never arrive.

  Separately: when every route fails, the player now releases ownership of the
  element it never played into. Otherwise the next player awaited a stop() on a
  dead one, and the dead one stayed reachable for as long as the element existed.

## 0.4.4

### Patch Changes

- `setVolume` now unmutes.

  Playback usually starts muted: apps put `muted` in their own markup because
  browsers refuse to autoplay with sound, and the SDK mutes and retries by
  itself when autoplay is blocked. `video.volume` does nothing while `muted` is
  set, so an app whose only audio control was a volume slider could never
  produce sound — the slider moved, the level read 1, the stream stayed silent,
  and nothing reported a problem. Reproduced on the drop-in demo against a live
  OBS stream: audio decoding at 220KB and rising, `muted: true` throughout.

  Any volume above zero clears `muted`; volume zero mutes, so a UI dragged to
  zero stays silent even if something else unmutes the element.

## 0.4.3

### Patch Changes

- Two defects a viewer sees directly, both reported against smooth video.

  **"buffering" never turned off.** `buffering` had no counterpart event, so an
  app that showed a spinner on it had nothing to hide the spinner on. One
  transient stall — normal at join — left the UI reading "buffering" over
  perfectly smooth playback for the rest of the session. Measured against a live
  OBS stream: `readyState` 4, `currentTime` advancing 2s every 2s, status stuck.
  `playing` is now re-emitted when the element resumes, so the pair closes.
  Consumers already handle `playing`; no new event to learn.

  **A second play() on the same element flooded the console.** Pressing play
  twice, or a component remounting, left the first player running: the new one
  resets the element, which detaches the old MediaSource and removes its
  SourceBuffers, and the orphan then polls buffers that belong to nothing —
  237 unhandled rejections in an 8-second window:

      InvalidStateError: Failed to read the 'buffered' property from
      'SourceBuffer': This SourceBuffer has been removed from the parent media
      source.

  An element has one owner now, and taking ownership stops the previous player.

## 0.4.2

### Patch Changes

- Make a browser broadcast watchable, and cut the join delay on the buffered routes.

  Four defects, found while probing a real publish/watch round trip against
  production rather than by reading code.

  **A browser broadcast reached non-WebRTC viewers as audio only.** Chrome
  negotiates VP8 for a WHIP publish; the server's HLS/FLV/CDN muxers cannot carry
  it and drop the video track (`skipping track 2 (VP8)`). The publisher saw a
  healthy preview and a correct bitrate the whole time. The SDK now offers H264
  first, which every delivery path speaks and which costs no server transcode.
  Measured on the origin playlist: `CODECS="opus"` at 32kbps became
  `CODECS="avc1.42001e,opus"` at 356kbps, 640x480.

  **The FLV route never started.** flv.js was created with its VOD defaults: a
  384KB IO stash held bytes before any reached MSE — about 8s at a webcam's
  bitrate, past the player's own first-frame watchdog, so a healthy stream was
  rejected as "delivered no video". `lazyLoad` also aborted the connection every
  3 minutes of buffer, which for live is a reconnect and a stall that buys
  nothing. Both off; SourceBuffer cleanup on; reconnects reuse the signed CDN URL.

  **An FLV header that claims audio the stream does not carry.** A WebRTC
  broadcast reaches the CDN as video only (Opus cannot ride in FLV) while the
  header still advertises audio, and flv.js waits forever for an audio init
  segment. The route now gives the normal attempt 2.5s and retries without audio
  only if no frame arrived — a publisher sending real AAC is untouched.

  **Latency only ever grew.** flv.js does not chase the live edge, so every stall
  became permanent delay; hls.js had `maxLiveSyncPlaybackRate` at its default 1,
  so it could never catch up either. Both now recover.

  Also fixed: buffered transports left their element listeners behind, and since
  every candidate route shares one video element, an abandoned route's live-edge
  chase would seek a healthy playback out from under itself. The unload beacon
  now sends `text/plain`, which is safelisted — `application/json` forced a CORS
  preflight at unload, where it frequently never completed and the last batch of
  every session was silently lost.

  End to end, browser publisher, watched over the CDN:

  | mode | first frame | stalls | drift |
  | --- | --- | --- | --- |
  | low-latency | 2158ms | 0 | real-time |
  | auto | 2908ms | 0 | 0.60s steady |
  | balanced | 3075ms | 0 | 0.80s steady |
  | scale | 6745ms | 0 | 5.2s (HLS) |

## 0.4.1

### Patch Changes

- Play the stream instead of a black rectangle.

  Reported as "the player shows no video although the stream is active, and the
  SDK never falls back — yet the same playlist plays fine in hls.js directly".
  Three defects; the first explains the whole report.

  **Autoplay policy, swallowed.** Every view transport called
  `video.play().catch(() => undefined)`, and nothing set `muted`. Chrome and
  Safari refuse playback WITH AUDIO without sticky user activation, and a click
  does not survive `await fetchToken()` + `await import("hls.js")`. So play()
  rejected, the element stayed on frame zero, and the SDK said nothing. The
  first-frame watchdog then timed out on every route in turn: the fallback DID
  run, it just could not succeed, which from outside looks like no fallback at
  all. Now: try with sound, and on a policy refusal mute and retry (muted
  playback is always allowed). Failures that are NOT the policy propagate, since
  a dead route is what the fallback is for.

  **`srcObject` blocked every later route.** A real-time route attaches a
  MediaStream via srcObject; HLS/FLV use src/MSE, and while srcObject is set the
  element ignores src. One failed WHEP attempt therefore kept the picture black
  no matter how healthy the playlist was. The player resets the element before
  each candidate, and the real-time route releases it on stop.

  **`lowLatencyMode: true` was forced** on ordinary playlists. That flag is for
  LL-HLS (`EXT-X-PART`); asserting it makes hls.js wait for parts that never
  arrive. hls.js turns it on itself when the playlist advertises it.

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
