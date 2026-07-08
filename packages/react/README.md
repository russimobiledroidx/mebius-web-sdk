# @mebius-io/react

React hooks untuk Mebius Web SDK — lapisan tipis di atas
[`@mebius-io/web`](../web). Konsep inti (auth, mode, events, error code) ada di
README `@mebius-io/web`; di sini fokus API hooks.

[![npm version](https://img.shields.io/badge/npm-%40mebius%2Freact-blue)](https://www.npmjs.com/package/@mebius-io/react)
[![license](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

## Install

Repo ini **private** (belum dipublish ke npm). Cara yang terbukti jalan adalah
**tarball**. Karena `@mebius-io/react` bergantung ke `@mebius-io/web`, install **kedua
tarball dalam satu perintah** supaya dependency `@mebius-io/web` terpenuhi dari
tarball lokal (kalau tidak, npm akan mencoba mengambilnya dari registry dan
gagal):

```bash
# Maintainer (di repo SDK):
pnpm pack:all   # -> mebius-web-0.1.0.tgz, mebius-react-0.1.0.tgz (di root repo)

# Consumer (kedua tarball sekaligus + react):
npm i ./mebius-web-0.1.0.tgz ./mebius-react-0.1.0.tgz react
```

Setelah dipublish ke registry npm (opsi masa depan):

```bash
npm i @mebius-io/react @mebius-io/web react
```

> Detail distribusi private (kenapa git install tidak dipakai, perilaku
> `workspace:*` saat pack) ada di README [`@mebius-io/web`](../web#distribusi-private-github--tarball).

## Hooks

| Hook | Return |
|---|---|
| `useMebius({ appId, gateway, token })` | `{ client, status, error }` |
| `useBroadcaster(client, options?)` | `{ broadcaster, previewRef, start, stop, switchCamera, setMicEnabled, setCameraEnabled, isLive }` |
| `usePlayer(client, { mode })` | `{ player, videoRef, play, stop, setVolume, isPlaying }` |

## Broadcast

```tsx
import { useMebius, useBroadcaster } from "@mebius-io/react";

function Broadcast({ token }: { token: string }) {
  const { client } = useMebius({ appId: "app_123", gateway: "https://gateway.mebius.io", token });
  const { previewRef, start, stop, switchCamera, setMicEnabled, isLive } = useBroadcaster(client);
  return (
    <div>
      <video ref={previewRef} autoPlay muted playsInline />
      <button onClick={() => (isLive ? stop() : start("my-stream"))}>
        {isLive ? "Stop" : "Go live"}
      </button>
      <button onClick={switchCamera}>Flip</button>
      <button onClick={() => setMicEnabled(false)}>Mute</button>
    </div>
  );
}
```

## Watch

```tsx
import { useMebius, usePlayer } from "@mebius-io/react";

function Watch({ token, streamId }: { token: string; streamId: string }) {
  const { client } = useMebius({ appId: "app_123", gateway: "https://gateway.mebius.io", token });
  const { videoRef, play, setVolume } = usePlayer(client, { mode: "low-latency" });
  return (
    <div>
      <video ref={videoRef} autoPlay playsInline />
      <button onClick={() => play(streamId)}>Play</button>
      <input type="range" min={0} max={1} step={0.1} onChange={(e) => setVolume(+e.target.value)} />
    </div>
  );
}
```

> Next.js: render komponen ini sebagai client component (`"use client"`) dan
> import dinamis dengan `{ ssr: false }` karena SDK butuh WebRTC browser.

## License

MIT
