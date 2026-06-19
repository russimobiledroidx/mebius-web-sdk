# Mebius — single-file JS SDK (drop-in, no build)

One self-contained file, just like `ZegoExpressWebRTC.js`. Download it, drop it
into your PHP (or any plain HTML) project, add a `<script>` tag — done. No npm,
no bundler, no build step. The scale-mode playback engine is bundled inside, so
the file has **zero external dependencies**.

## Files

| File | Use |
|---|---|
| `mebius.min.js` | production (minified, ~520 KB) |
| `mebius.js` | dev (readable) |

Download the raw file straight from GitHub:

```
https://raw.githubusercontent.com/russimobiledroidx/mebius-web-sdk/v0.1.0/packages/web/standalone/mebius.min.js
```

Save it next to your PHP files, e.g. `assets/mebius.min.js`.

## Use in PHP (paste this in)

```php
<?php
// Your backend mints a short-lived token from (appId + appSecret).
// The app secret NEVER leaves the server. Use the mebius-php SDK or any JWT lib.
$token = mint_mebius_token_for_current_user(); // returns a JWT string
?>
<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <video id="preview" autoplay muted playsinline width="360"></video>
  <video id="viewer"  autoplay playsinline width="360"></video>
  <button id="go">Go live</button>
  <button id="watch">Watch</button>

  <!-- the one file -->
  <script src="assets/mebius.min.js"></script>
  <script>
    // Mebius is a global — native JS, no imports.
    Mebius.init({ appId: "app_123", gateway: "https://gateway.mebius.io" });
    const client = Mebius.connect({ token: <?= json_encode($token) ?> });

    client.on("error", (e) => console.warn("[mebius]", e.code, e.message));

    // Broadcast
    const broadcaster = client.createBroadcaster({ video: true, audio: true });
    document.getElementById("go").onclick = async () => {
      await broadcaster.start("demo-stream");
      broadcaster.attachPreview("#preview");
    };

    // Watch
    const player = client.createPlayer({ mode: "low-latency" }); // or "scale"
    document.getElementById("watch").onclick = () =>
      player.play("demo-stream", "#viewer");
  </script>
</body>
</html>
```

That's the whole integration. See `example.php` in this folder for a fuller
two-screen version (start/stop, switch camera, mute, volume, mode toggle).

## Globals exposed

- `Mebius` — `Mebius.init({ appId, gateway })`, `Mebius.connect({ token })`
- `MebiusError` — thrown/emitted errors carry a `.code` (`TOKEN_EXPIRED`,
  `PERMISSION_DENIED`, `CONNECTION_FAILED`, `NOT_CONNECTED`, `STREAM_NOT_FOUND`)

API is identical to `@mebius/web` — see the [package README](../README.md) for
the full method/event reference.

## Notes

- **HTTPS required in production** (WebRTC needs a secure context). `localhost`
  is fine for development.
- Token must be minted server-side. With PHP, use the
  [mebius-php](https://github.com/russimobiledroidx/mebius-php) server SDK
  (`Mebius\TokenIssuer`) or any JWT library.
- Rebuild this file after SDK changes with: `pnpm --filter @mebius/web build:standalone`.
