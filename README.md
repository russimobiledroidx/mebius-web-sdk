<div align="center">

# Mebius Web SDK

**Live streaming untuk web — API sederhana, transport disembunyikan.**

Broadcast dari kamera/mikrofon dan tonton stream real-time hanya dengan beberapa
baris kode. Kamu bekerja dengan konsep Mebius (mode playback, event, error) —
detail protokol diurus SDK di balik layar.

[![@mebius-io/web](https://img.shields.io/npm/v/@mebius-io/web?label=%40mebius-io%2Fweb)](https://www.npmjs.com/package/@mebius-io/web)
[![@mebius-io/react](https://img.shields.io/npm/v/@mebius-io/react?label=%40mebius-io%2Freact)](https://www.npmjs.com/package/@mebius-io/react)
[![@mebius-io/react-native](https://img.shields.io/npm/v/@mebius-io/react-native?label=%40mebius-io%2Freact-native)](https://www.npmjs.com/package/@mebius-io/react-native)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

## Install

```bash
npm i @mebius-io/web           # core (vanilla TS / browser)
npm i @mebius-io/react         # React hooks (+ @mebius-io/web)
npm i @mebius-io/react-native  # React Native (backed by react-native-webrtc)
```

`pnpm add` / `yarn add` juga didukung. Semua dependency internal ikut terpasang
otomatis — kamu **tidak perlu** memasang atau menyentuh library streaming pihak
ketiga apa pun.

## Quick start

```ts
import { Mebius } from "@mebius-io/web";

// 1. Konfigurasi sekali.
Mebius.init({ appId: "app_123", gateway: "https://gateway.mebius.io" });

// 2. Token short-lived di-mint backend-mu (app secret tak pernah di client).
const token = await fetch("/api/mebius-token?streamId=my-stream&role=viewer").then((r) => r.text());
const client = Mebius.connect({ token });

// 3a. Tonton.
const player = client.createPlayer({ mode: "low-latency" }); // atau "scale"
await player.play("my-stream", "#viewer");                    // <video id="viewer">

// 3b. …atau broadcast.
const broadcaster = client.createBroadcaster({ video: true, audio: true });
await broadcaster.start("my-stream");
```

React:

```tsx
import { useMebius, usePlayer } from "@mebius-io/react";

function Watch({ token, streamId }: { token: string; streamId: string }) {
  const { client } = useMebius({ appId: "app_123", gateway: "https://gateway.mebius.io", token });
  const { videoRef, play } = usePlayer(client, { mode: "low-latency" });
  return <video ref={videoRef} onClick={() => play(streamId)} autoPlay playsInline />;
}
```

Dokumentasi lengkap per package: **[`@mebius-io/web`](packages/web/README.md)** ·
[`@mebius-io/react`](packages/react/README.md) ·
[`@mebius-io/react-native`](packages/react-native/README.md).

## Fitur

- **API mode-based** — pilih `"low-latency"` (interaktif, sub-detik) atau
  `"scale"` (audiens besar). SDK memilih delivery yang tepat otomatis.
- **Transport tersembunyi** — kode kliennya bicara istilah Mebius saja; tidak
  ada library streaming pihak ketiga yang perlu kamu impor atau kelola.
- **Broadcast + watch** dari satu API yang konsisten lintas platform.
- **Aman by design** — app secret tetap di backend; client hanya menerima token
  short-lived per-stream.
- **Type-safe** — TypeScript penuh, ESM + CJS + UMD, tree-shakeable.

## Packages

| Package | Deskripsi |
|---|---|
| [`@mebius-io/web`](packages/web) | Core SDK, vanilla TypeScript (browser WebRTC + HLS). |
| [`@mebius-io/react`](packages/react) | React hooks tipis di atas `@mebius-io/web`. |
| [`@mebius-io/react-native`](packages/react-native) | Bindings React Native (via `react-native-webrtc`). |

## Requirements

- Browser modern dengan WebRTC (Chrome, Edge, Firefox, Safari terbaru).
- **HTTPS** di production (`localhost` boleh untuk dev).
- Node 20+ hanya untuk build tooling — bukan runtime SDK.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm check:abstraction   # gagal jika ada istilah protokol bocor ke API publik
```

Butuh Node 20+ dan pnpm 9+. Public API Mebius tidak pernah membocorkan detail
transport: CI menjalankan `pnpm check:abstraction`, dan seluruh detail protokol
hanya hidup di direktori `internal/`.

## License

[MIT](LICENSE) © Mebius
