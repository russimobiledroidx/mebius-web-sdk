# Mebius — single-file JS SDK (drop-in, no build)

One self-contained file. Download it, drop it into your PHP (or any plain HTML)
project, add a `<script>` tag — done. No npm,
no bundler, no build step. The scale-mode playback engine is bundled inside, so
the file has **zero external dependencies**. `Mebius` becomes a global.

## Files

| File | Use |
|---|---|
| `mebius.min.js` | production (minified, ~520 KB) |
| `mebius.js` | dev (readable) |

The repo is private, so grab the file once (you have repo access), then commit
it into your project (e.g. `assets/mebius.min.js`) or serve it from your own
server. Your end users load it from your site — they never touch GitHub.

```bash
# you, once (with repo access):
curl -L -H "Authorization: token <YOUR_GH_PAT>" \
  https://raw.githubusercontent.com/russimobiledroidx/mebius-web-sdk/v0.1.0/packages/web/standalone/mebius.min.js \
  -o assets/mebius.min.js
```

---

## Mental model (1 minute)

```
Mebius.init({ appId, gateway })   // configure once (public values, safe in client)
client  = Mebius.connect({ token })   // token minted by YOUR backend
player  = client.createPlayer({ mode })          // viewer
broadcaster = client.createBroadcaster({ video, audio })   // host
player.play(streamId, "#video")  /  broadcaster.start(streamId)
```

- **`gateway`** = your Mebius signaling URL (public).
- **`token`** = short-lived JWT your backend mints from (appId + appSecret).
  The **app secret never touches the browser** — you only ship the token.
- **`streamId`** = the stream to publish/watch.
- **`mode`** = `"low-latency"` (interactive) or `"scale"` (big audience). Mebius
  picks the delivery automatically; you never deal with the transport.

> ⚠️ **Security:** never put your app secret / server secret in the browser.
> The client gets ONLY `appId`, `gateway`, and a short-lived `token`. The secret
> stays on your PHP server and is used there to mint the token.

---

## Call reference (what each action maps to)

| You want to… | Mebius call |
|---|---|
| Set up the SDK | `Mebius.init({ appId, gateway })` |
| Authenticate / connect | `Mebius.connect({ token })` → `client` (no separate room login) |
| Watch a stream | `player.play(streamId, "#el")` (one call, renders into the element) |
| Mute / unmute playback | `player.setVolume(0)` / `player.setVolume(1)` |
| Stop watching / leave | `player.stop()` (+ `client.disconnect()` to fully leave) |
| Go live (publish) | `broadcaster.start(streamId)` |
| Wait until the SDK is loaded | check `window.Mebius` (see `waitForMebius`) |
| Handle errors | `client.on("error", e => …)` with `e.code` |

There is **no room concept** — you address streams by a `streamId` string. If
you key streams off something like `` `${roomId}_stream` ``, just build that
string yourself and pass it as `streamId`.

---

## A. PHP — viewer (full flow)

Server mints the token (secret stays server-side), injects `appId`/`gateway`
and the token into the page. Flow: fetch token → connect → play → mute/leave,
with a status UI and an SDK-ready wait. (jQuery used only for DOM — it is NOT
required by Mebius.)

```php
<?php
// Mint the token on the server. Use the mebius-php SDK or any JWT lib.
// $issuer = new Mebius\TokenIssuer($appId, $appSecret);
// $token  = $issuer->mintPlayToken($streamId, $userId);   // viewer => "play"
$appId   = (int) env('MEBIUS_APP_ID');
$gateway = env('MEBIUS_GATEWAY');                 // public signaling URL
$token   = fetch_mebius_token_for_user();         // your backend mint (server-side secret)
?>
<div id="status" class="alert d-none"></div>
<div id="remoteVideo"></div>
<button id="muteBtn">🔊 Mute</button>
<button id="leaveBtn">Leave</button>

<script src="assets/mebius.min.js"></script>
<script>
  const CONFIG = {
    appId:   <?= json_encode($appId) ?>,
    gateway: <?= json_encode($gateway) ?>,   // NOT a secret
    token:   <?= json_encode($token) ?>,     // short-lived, from your backend
  };

  let client = null, player = null, muted = false;
  const status = $('#status');

  function showStatus(msg, type = 'info') {
    const map = { info:'alert-info', success:'alert-success', error:'alert-danger' };
    status.removeClass().addClass('alert ' + (map[type] || 'alert-info')).text(msg).removeClass('d-none');
  }
  const hideStatus = () => status.addClass('d-none');

  // wait until the single-file SDK global is ready
  function waitForMebius(cb, maxAttempts = 50) {
    let n = 0;
    const t = setInterval(() => {
      if (window.Mebius) { clearInterval(t); cb(); }
      else if (++n >= maxAttempts) { clearInterval(t); showStatus('❌ Failed to load Mebius SDK', 'error'); }
    }, 100);
  }

  async function joinStream(streamId, mode = 'low-latency') {
    try {
      showStatus('Connecting...', 'info');
      Mebius.init({ appId: CONFIG.appId, gateway: CONFIG.gateway });
      client = Mebius.connect({ token: CONFIG.token });
      client.on('error', (e) => showStatus(`❌ ${e.code}: ${e.message}`, 'error'));

      player = client.createPlayer({ mode });          // "low-latency" or "scale"
      player.on('buffering', () => showStatus('Buffering...', 'info'));
      player.on('playing',  () => showStatus(`✅ Watching ${streamId}`, 'success'));

      showStatus('Starting playback...', 'info');

      // optional 30s timeout, like the sample
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000));
      await Promise.race([ player.play(streamId, '#remoteVideo'), timeout ]);

      setTimeout(hideStatus, 1500);
    } catch (err) {
      const msg = err.message === 'timeout'
        ? 'Stream not available. Host may not be streaming yet.'
        : err.message;
      showStatus(`❌ ${msg}`, 'error');
    }
  }

  function toggleMute() {
    if (!player) return;
    muted = !muted;
    player.setVolume(muted ? 0 : 1);                  // Mebius: volume 0 == muted
    $('#muteBtn').text(muted ? '🔇 Unmute' : '🔊 Mute');
  }

  async function leaveStream() {
    try {
      if (player) { await player.stop(); player = null; }
      if (client) { client.disconnect(); client = null; }
      showStatus('Left stream', 'success');
      setTimeout(hideStatus, 1500);
    } catch (e) { console.error(e); }
  }

  $(document).ready(() => {
    showStatus('Initializing...', 'info');
    waitForMebius(() => {
      $('#muteBtn').on('click', toggleMute);
      $('#leaveBtn').on('click', leaveStream);
      joinStream('<?= $streamId ?>', 'low-latency');   // streamId from PHP
    });
  });
</script>
```

A complete runnable file with both Broadcast and Watch screens is in
[`example.php`](./example.php) (`php -S localhost:8000 example.php`).

---

## B. Native JS — viewer (no jQuery, no framework)

Same flow, plain DOM:

```html
<div id="remoteVideo"></div>
<button id="mute">🔊 Mute</button>
<button id="leave">Leave</button>

<script src="mebius.min.js"></script>
<script>
  const APP_ID = 123, GATEWAY = "https://gateway.mebius.io";

  async function getToken() {
    // your backend mints it; secret stays on the server
    const r = await fetch("/api/mebius-token?role=viewer&streamId=demo-stream");
    return (await r.text()).trim();
  }

  let client, player, muted = false;

  async function watch(streamId, mode = "low-latency") {
    Mebius.init({ appId: APP_ID, gateway: GATEWAY });
    client = Mebius.connect({ token: await getToken() });
    client.on("error", (e) => console.warn(e.code, e.message));

    player = client.createPlayer({ mode });           // or "scale"
    player.on("playing", () => console.log("playing", streamId));
    await player.play(streamId, "#remoteVideo");
  }

  document.getElementById("mute").onclick = () => {
    if (!player) return;
    muted = !muted;
    player.setVolume(muted ? 0 : 1);
    mute.textContent = muted ? "🔇 Unmute" : "🔊 Mute";
  };
  document.getElementById("leave").onclick = async () => {
    await player?.stop(); client?.disconnect(); player = client = null;
  };

  watch("demo-stream");
</script>
```

---

## C. Native JS — broadcaster (host)

```html
<video id="preview" autoplay muted playsinline></video>
<button id="go">Go live</button>
<button id="flip">Switch camera</button>
<button id="mic">Mute mic</button>

<script src="mebius.min.js"></script>
<script>
  Mebius.init({ appId: 123, gateway: "https://gateway.mebius.io" });
  let micOn = true, b;

  document.getElementById("go").onclick = async () => {
    const token = await fetch("/api/mebius-token?role=broadcaster&streamId=demo-stream").then(r => r.text());
    const client = Mebius.connect({ token });
    b = client.createBroadcaster({ video: true, audio: true });
    await b.start("demo-stream");        // internally negotiates with the gateway (hidden)
    b.attachPreview("#preview");         // local preview
  };
  document.getElementById("flip").onclick = () => b?.switchCamera();
  document.getElementById("mic").onclick  = () => b?.setMicEnabled(micOn = !micOn);
</script>
```

---

## Globals exposed

- `Mebius` — `Mebius.init({ appId, gateway })`, `Mebius.connect({ token })`
- `MebiusError` — errors carry a `.code`: `TOKEN_EXPIRED`, `PERMISSION_DENIED`,
  `CONNECTION_FAILED`, `NOT_CONNECTED`, `STREAM_NOT_FOUND`

### Full API (identical to `@mebius-io/web`)

| Object | Method | Notes |
|---|---|---|
| `Mebius` | `init({ appId, gateway })` | call once |
| `Mebius` | `connect({ token })` → `client` | token from backend |
| `client` | `createPlayer({ mode })` → `player` | `mode: "low-latency" \| "scale"` |
| `client` | `createBroadcaster({ video, audio })` → `broadcaster` | |
| `client` | `disconnect()` | leave entirely |
| `client` | `on("connected"\|"disconnected"\|"error", cb)` | |
| `player` | `play(streamId, "#el")` / `stop()` | renders into the element |
| `player` | `setVolume(0..1)` | `0` = muted |
| `player` | `on("playing"\|"buffering"\|"ended"\|"stats", cb)` | |
| `broadcaster` | `start(streamId)` / `stop()` | |
| `broadcaster` | `switchCamera()` / `setMicEnabled(bool)` / `setCameraEnabled(bool)` | |
| `broadcaster` | `attachPreview("#el")` | local preview |
| `broadcaster` | `on("started"\|"stopped"\|"stats", cb)` | |

## Notes

- **HTTPS required in production** (WebRTC needs a secure context). `localhost`
  is fine for dev.
- **Token = server-side only.** Mint it in PHP with the
  [mebius-php](https://github.com/russimobiledroidx/mebius-php) SDK
  (`Mebius\TokenIssuer`) or any JWT lib. Never embed the app secret in the page.
- **`TOKEN_EXPIRED`** → fetch a fresh token from your backend and `connect` again.
- Rebuild this file after SDK changes: `pnpm --filter @mebius-io/web build:standalone`.
