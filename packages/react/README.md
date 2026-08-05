# @mebius-io/react

React hooks untuk Mebius Web SDK — lapisan tipis di atas
[`@mebius-io/web`](../web). Konsep inti (auth, mode, events, error code) ada di
README `@mebius-io/web`; di sini fokus API hooks.

[![npm version](https://img.shields.io/badge/npm-%40mebius%2Freact-blue)](https://www.npmjs.com/package/@mebius-io/react)
[![license](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

## Install

Sudah **live di npm** (public). Satu perintah cukup — `@mebius-io/web`
(dependency) dan `react` (peer) ikut otomatis dari registry:

```bash
npm i @mebius-io/react
# atau: pnpm add @mebius-io/react / yarn add @mebius-io/react
```

> Butuh install offline / tanpa registry? Pakai tarball — di mode ini `@mebius-io/web`
> TIDAK ikut otomatis, jadi install kedua tarball (`web` + `react`) dalam satu
> perintah. Detail di README [`@mebius-io/web`](../web#distribusi-via-tarball-offline--tanpa-registry).

## Hooks

| Hook | Return |
|---|---|
| `useMebius({ appId, gateway, token, deliveries?, beaconToken?, beaconUrl?, userId? })` | `{ client, status, error }` |
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

## `deliveries` / `beaconToken` / `beaconUrl`

Ketiganya datang dari response token yang sama, dan diteruskan apa adanya ke
`@mebius-io/web`:

```tsx
const { token, deliveries, beaconToken, beaconUrl } = await (await fetch("/api/mebius-token")).json();
const { client } = useMebius({ appId, gateway, token, deliveries, beaconToken, beaconUrl });
```

- `deliveries` — rute playback pilihan gateway. Tanpa itu playback tetap jalan,
  tapi setiap penonton dilayani dari origin Mebius, bukan edge terdekat.
  **Memoize array-nya**: identitas array baru tiap render me-reconnect client,
  sama seperti `token` yang berubah.
- `beaconToken` + `beaconUrl` — mengisi **Quality → Publish / Play** di dashboard
  Mebius dan jadi dasar hitung **viewer minutes**. Tanpa keduanya stream jalan
  normal, kamu cuma tak melihat data kualitasnya. Aman di client: kredensialnya
  terikat klaim bertanda tangan ke satu stream dan satu project. Tambah `userId`
  kalau ingin laporan membawa id penggunamu.

Mengubah `beaconToken` atau `beaconUrl` me-reconnect client, sama seperti `token`.

## License

MIT
