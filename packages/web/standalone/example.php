<?php
/**
 * Mebius single-file SDK — PHP integration example.
 *
 * Serve this with any PHP server (`php -S localhost:8000 example.php`) and open
 * it in a browser. In a real app, mint the token with the mebius-php server SDK
 * (Mebius\TokenIssuer) from your appId + appSecret — the secret stays on the
 * server and never reaches the browser.
 */

// --- token (DEMO) -----------------------------------------------------------
// Replace with a real mint, e.g.:
//   $issuer = new Mebius\TokenIssuer($appId, $appSecret);
//   $token  = $issuer->mintPublishToken('demo-stream', 'user-1');
$token = getenv('MEBIUS_DEMO_TOKEN') ?: 'REPLACE_WITH_TOKEN_FROM_BACKEND';

$appId   = getenv('MEBIUS_APP_ID')  ?: 'app_demo';
$gateway = getenv('MEBIUS_GATEWAY') ?: 'https://gateway.mebius.io';
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mebius — PHP single-file demo</title>
  <style>
    body { font: 15px system-ui; margin: 24px; max-width: 760px; }
    section { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 12px 0; }
    video { width: 100%; background: #000; border-radius: 6px; }
    button { padding: 8px 12px; margin: 4px 4px 0 0; }
  </style>
</head>
<body>
  <h1>Mebius — PHP (single file, no build)</h1>

  <section>
    <h2>Broadcast</h2>
    <video id="preview" autoplay muted playsinline></video>
    <div>
      <button id="go-live">Go live</button>
      <button id="stop-live">Stop</button>
      <button id="flip">Switch camera</button>
      <button id="mute">Mute mic</button>
    </div>
  </section>

  <section>
    <h2>Watch</h2>
    <video id="viewer" autoplay playsinline></video>
    <div>
      <input id="stream-id" value="demo-stream" />
      <select id="mode">
        <option value="low-latency">low-latency</option>
        <option value="scale">scale</option>
      </select>
      <button id="play">Play</button>
      <button id="stop-play">Stop</button>
      <input id="volume" type="range" min="0" max="1" step="0.1" value="1" />
    </div>
  </section>

  <!-- The one file. Download it to assets/ from:
       https://raw.githubusercontent.com/russimobiledroidx/mebius-web-sdk/v0.1.0/packages/web/standalone/mebius.min.js -->
  <script src="mebius.min.js"></script>
  <script>
    // Native JS — Mebius is a global, no imports.
    Mebius.init({
      appId: <?= json_encode($appId) ?>,
      gateway: <?= json_encode($gateway) ?>,
    });
    const client = Mebius.connect({ token: <?= json_encode($token) ?> });
    client.on("error", (e) => console.warn("[mebius]", e.code, e.message));

    // --- Broadcast ---
    let micOn = true;
    const broadcaster = client.createBroadcaster({ video: true, audio: true });
    go_live.onclick   = async () => { await broadcaster.start("demo-stream"); broadcaster.attachPreview("#preview"); };
    stop_live.onclick = () => broadcaster.stop();
    flip.onclick      = () => broadcaster.switchCamera();
    mute.onclick      = () => broadcaster.setMicEnabled(micOn = !micOn);

    // --- Watch ---
    let player = null;
    play.onclick = async () => {
      player = client.createPlayer({ mode: mode.value });
      await player.play(stream_id.value, "#viewer");
    };
    stop_play.onclick = () => player && player.stop();
    volume.oninput    = (e) => player && player.setVolume(Number(e.target.value));
  </script>
</body>
</html>
