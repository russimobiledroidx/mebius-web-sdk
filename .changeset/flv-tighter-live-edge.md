---
"@mebius-io/web": patch
"@mebius-io/react": patch
"@mebius-io/react-native": patch
---

Keep FLV viewers closer to live, and say which route is playing.

- **FLV (`fast` route) catches up sooner.** The picture now jumps back to the target once it is more than 2s past it (was 4× target, i.e. 8s at the default 2s), and the band between 1.5× target and that threshold plays at 1.1× (was 1.05×, which took ~100s to win back 5s). HLS routes are unchanged and keep using hls.js `liveSyncDuration`.
- **`player.route` and the `route` event.** `player.route` is the delivery route currently playing (`"realtime" | "fast" | "wide" | "local"`, or `null`), and `route` fires with `{ kind }` each time a route is accepted, before the matching `playing`. Apps no longer need to infer the route from `.m3u8` requests. New exported type: `PlaybackRoute`.
