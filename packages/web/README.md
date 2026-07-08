# @mebius-io/web

SDK web Mebius untuk live streaming — install, ikuti docs, hit API.

[![npm version](https://img.shields.io/badge/npm-%40mebius%2Fweb-blue)](https://www.npmjs.com/package/@mebius-io/web)
[![license](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

## Requirements

- Browser modern dengan WebRTC (Chrome, Edge, Firefox, Safari terbaru).
- **HTTPS wajib di production.** `localhost` boleh dipakai untuk development.
- Node 20+ hanya untuk build tooling (bukan runtime SDK).

## Install

> Repo ini **private** dan belum dipublish ke npm registry / domain manapun.
> Metode install yang terbukti jalan adalah **tarball** (di bawah). Lihat
> [Distribusi private](#distribusi-private-github--tarball) untuk detail +
> caveat git install.

### Tarball (cara utama, paling reliable)

Maintainer membuat tarball sekali per rilis, lalu consumer install dari file:

```bash
# Maintainer (di repo SDK):
pnpm --filter @mebius-io/web build
pnpm --filter @mebius-io/web pack            # -> packages/web/mebius-web-0.1.0.tgz

# Consumer (di project kamu):
npm i ./mebius-web-0.1.0.tgz
# atau: pnpm add ./mebius-web-0.1.0.tgz / yarn add ./mebius-web-0.1.0.tgz
```

Tarball sudah berisi `dist/` (ESM + CJS + UMD + types) dan menarik dependency
runtime (`hls.js`) otomatis. Tidak perlu build di sisi consumer.

```ts
const { Mebius } = require("@mebius-io/web"); // CJS — works
import { Mebius } from "@mebius-io/web";       // ESM — works
```

Setelah package dipublish ke npm registry (opsi masa depan, npm tidak butuh
domain):

```bash
npm i @mebius-io/web
# atau: pnpm add @mebius-io/web / yarn add @mebius-io/web
```

Via CDN (UMD global `Mebius`) — hanya tersedia setelah publish ke registry/CDN:

```html
<script src="https://unpkg.com/@mebius-io/web/dist/index.global.js"></script>
<script>
  Mebius.Mebius.init({ appId: "app_123", gateway: "https://gateway.mebius.io" });
</script>
```

### Single-file drop-in (PHP / plain HTML, no build)

For PHP or any plain-HTML project: download ONE self-contained file and add a
`<script>` tag — no npm, no bundler. The scale engine is bundled in; zero
external deps. `Mebius` becomes a global.

```html
<script src="mebius.min.js"></script>
<script>
  Mebius.init({ appId: "app_123", gateway: "https://gateway.mebius.io" });
  const client = Mebius.connect({ token }); // token from your backend
</script>
```

File + full PHP example: [`standalone/`](./standalone/). Raw download:
`https://raw.githubusercontent.com/russimobiledroidx/mebius-web-sdk/v0.1.0/packages/web/standalone/mebius.min.js`

## Quick Start

### a. Auth

> Token di-mint dari **backend kamu**, JANGAN embed `appSecret` di client.
> Backend menukar (appId + appSecret) jadi JWT short-lived; client cuma terima
> string token-nya.

### b. Init + connect

```ts
import { Mebius } from "@mebius-io/web";

Mebius.init({ appId: "app_123", gateway: "https://gateway.mebius.io" });

const token = await fetch("/api/mebius-token").then((r) => r.text());
const client = Mebius.connect({ token });

client.on("connected", () => console.log("Mebius connected"));
client.on("error", (err) => {
  if (err.code === "TOKEN_EXPIRED") {
    // refresh token dari backend, lalu connect ulang
  }
});
```

### c. Broadcast

```ts
const broadcaster = client.createBroadcaster({ video: true, audio: true });

broadcaster.on("started", ({ streamId }) => console.log("live:", streamId));
broadcaster.on("stats", (s) => console.log(s.bitrateKbps, "kbps"));

await broadcaster.start("my-stream");
broadcaster.attachPreview("#preview"); // preview lokal (web convenience)

// kontrol
broadcaster.setMicEnabled(false);
broadcaster.setCameraEnabled(true);
await broadcaster.switchCamera();

// stop
await broadcaster.stop();
```

### d. Watch

```ts
const player = client.createPlayer({ mode: "low-latency" }); // atau "scale"

player.on("playing", ({ streamId }) => console.log("playing", streamId));
player.on("buffering", () => console.log("buffering..."));
player.on("ended", () => console.log("ended"));

await player.play("my-stream", "#viewer"); // <video id="viewer">
player.setVolume(0.8);

await player.stop();
```

Ganti mode kapan saja dengan membuat player baru: `mode: "low-latency"` untuk
delay minimum, `mode: "scale"` untuk audiens besar.

## Integrasi per framework

### Vanilla JS

ESM:

```ts
import { Mebius } from "@mebius-io/web";
Mebius.init({ appId, gateway });
const client = Mebius.connect({ token });
```

UMD `<script>`:

```html
<script src="https://unpkg.com/@mebius-io/web/dist/index.global.js"></script>
<script>
  const { Mebius } = window.Mebius;
  Mebius.init({ appId, gateway });
</script>
```

### React

Pakai `@mebius-io/react` (hooks tipis di atas package ini):

```tsx
import { useMebius, usePlayer } from "@mebius-io/react";

function Watch({ token, streamId }) {
  const { client } = useMebius({ appId, gateway, token });
  const { videoRef, play } = usePlayer(client, { mode: "low-latency" });
  return <video ref={videoRef} onClick={() => play(streamId)} autoPlay />;
}
```

### Next.js

```tsx
"use client";
import dynamic from "next/dynamic";
// SDK butuh WebRTC browser → jangan render di server.
const Watch = dynamic(() => import("../components/Watch"), { ssr: false });
export default function Page() {
  return <Watch />;
}
```

### Vue 3 (Composition API)

```ts
import { onMounted, onUnmounted, ref } from "vue";
import { Mebius } from "@mebius-io/web";

export function useWatch(streamId: string) {
  const video = ref<HTMLVideoElement>();
  let player: ReturnType<ReturnType<typeof Mebius.connect>["createPlayer"]>;
  onMounted(async () => {
    Mebius.init({ appId, gateway });
    const client = Mebius.connect({ token: await getToken() });
    player = client.createPlayer({ mode: "low-latency" });
    await player.play(streamId, video.value!);
  });
  onUnmounted(() => player?.stop());
  return { video };
}
```

### Vite

Tidak ada config khusus. ESM langsung jalan; `hls.js` di-load lazy hanya saat
mode `"scale"` dipakai, jadi tidak menambah bundle low-latency.

## API Reference

| Class | Method | Return | Keterangan |
|---|---|---|---|
| `Mebius` | `init({ appId, gateway })` | `void` | Konfigurasi sekali di awal. |
| `Mebius` | `connect({ token })` | `MebiusClient` | Buka koneksi. |
| `MebiusClient` | `createBroadcaster({ video?, audio? })` | `MebiusBroadcaster` | |
| `MebiusClient` | `createPlayer({ mode })` | `MebiusPlayer` | `mode: "low-latency" \| "scale"` |
| `MebiusClient` | `disconnect(reason?)` | `void` | |
| `MebiusBroadcaster` | `start(streamId)` | `Promise<void>` | |
| `MebiusBroadcaster` | `stop()` | `Promise<void>` | |
| `MebiusBroadcaster` | `switchCamera()` | `Promise<void>` | |
| `MebiusBroadcaster` | `setMicEnabled(bool)` | `void` | |
| `MebiusBroadcaster` | `setCameraEnabled(bool)` | `void` | |
| `MebiusBroadcaster` | `attachPreview(target)` | `void` | Preview lokal (web). |
| `MebiusPlayer` | `play(streamId, viewTarget)` | `Promise<void>` | `viewTarget`: `<video>` atau selector. |
| `MebiusPlayer` | `stop()` | `Promise<void>` | |
| `MebiusPlayer` | `setVolume(0..1)` | `void` | |

### Events

| Emitter | Event | Payload |
|---|---|---|
| client | `connected` | — |
| client | `disconnected` | `{ reason? }` |
| client | `error` | `MebiusError` |
| broadcaster | `started` | `{ streamId }` |
| broadcaster | `stopped` | — |
| broadcaster | `stats` | `{ bitrateKbps, framesPerSecond, rttMs? }` |
| player | `playing` | `{ streamId }` |
| player | `buffering` | — |
| player | `ended` | — |
| player | `stats` | `{ bitrateKbps, framesPerSecond, latencyMs? }` |

```ts
client.on("connected", () => {});
client.on("error", (e) => console.warn(e.code, e.message));
broadcaster.on("stats", (s) => console.log(s.bitrateKbps));
```

## Error handling

Semua error adalah `MebiusError` dengan `.code`:

| Code | Arti | Recover |
|---|---|---|
| `TOKEN_EXPIRED` | Token habis masa berlaku | Mint token baru di backend, connect ulang. |
| `PERMISSION_DENIED` | Izin kamera/mic ditolak | Minta user mengizinkan, retry `start()`. |
| `CONNECTION_FAILED` | Gagal konek ke gateway | Cek jaringan/gateway, retry dengan backoff. |
| `NOT_CONNECTED` | Dipakai sebelum `connect()` | Pastikan `connect()` sukses dulu. |
| `STREAM_NOT_FOUND` | Stream tidak ada | Verifikasi `streamId`. |

```ts
client.on("error", (e) => {
  switch (e.code) {
    case "TOKEN_EXPIRED": return refreshAndReconnect();
    case "PERMISSION_DENIED": return showPermissionHelp();
    default: console.error(e);
  }
});
```

## Troubleshooting

- **Izin kamera/mic:** browser hanya memberi izin di context aman (HTTPS atau
  `localhost`). Pastikan halaman tidak dibuka via `file://`.
- **HTTPS:** WebRTC butuh secure context di production.
- **Autoplay:** browser memblok autoplay dengan suara. Mulai playback setelah
  interaksi user, atau set `muted` dulu lalu unmute via `setVolume`.

## Distribusi private (GitHub / tarball)

SDK ini hidup di **monorepo private** (`russimobiledroidx/mebius-web-sdk`)
dengan 3 package: `@mebius-io/web` (core, tanpa dependency internal), `@mebius-io/react`,
`@mebius-io/react-native`. Tidak ada registry/domain publik. Berikut metode install
beserta tingkat keandalannya — apa adanya, tanpa janji palsu.

### ✅ Tarball — reliable (cara utama)

```bash
# 1. Maintainer build + pack semua package sekaligus (di repo SDK):
pnpm pack:all
#   -> mebius-web-0.1.0.tgz
#      mebius-react-0.1.0.tgz
#      mebius-react-native-0.1.0.tgz   (di root repo)

# 2. Consumer install (copy .tgz ke project, lalu):
npm i ./mebius-web-0.1.0.tgz
```

Selalu jalan untuk repo private karena tidak menyentuh registry sama sekali.
`@mebius-io/web` self-contained (tidak punya workspace dep), jadi paling bersih.

### ⚠️ git install — TIDAK reliable untuk monorepo subpackage

`npm i 'github:russimobiledroidx/mebius-web-sdk'` **tidak** bisa dipakai untuk
menginstall satu sub-package: npm/pnpm meng-clone seluruh repo dan hanya membaca
`package.json` di root, yang `private: true` dan bukan salah satu dari ketiga
package. npm juga tidak mendukung pemilihan sub-direktori untuk git dependency
secara native. Jadi metode ini **tidak didukung** di sini — pakai tarball.

(Catatan: tool pihak ketiga seperti `gitpkg` mem-publish subdir sebagai git URL,
tetapi **tidak bekerja untuk repo private**. Karena itu tarball adalah jalur
utama.)

### Cross-package dependency (react / react-native)

`@mebius-io/react` bergantung ke `@mebius-io/web`. Saat di-pack, pnpm menulis ulang
`workspace:*` menjadi versi konkret (`"@mebius-io/web": "0.1.0"`) yang tidak ada di
registry manapun untuk repo private ini. Akibatnya, **install tarball react
sendirian akan gagal** (npm mencoba mengambil `@mebius-io/web@0.1.0` dari registry).

Solusi: install kedua tarball dalam **satu perintah** supaya npm memuaskan
`@mebius-io/web@0.1.0` dari tarball lokal yang kamu sediakan:

```bash
npm i ./mebius-web-0.1.0.tgz ./mebius-react-0.1.0.tgz react
```

`@mebius-io/web` (core) dan `@mebius-io/react-native` (skeleton, tanpa dep internal)
bisa di-install standalone tanpa kendala ini.

### Opsi masa depan (lebih mulus): npm publish / GitHub Packages

Tidak seperti Maven Central, **npm tidak punya syarat domain**. Begitu siap,
publish ke registry npm privat atau **GitHub Packages** menghapus seluruh dance
tarball:

```bash
pnpm release   # turbo build + changeset publish
# consumer cukup: npm i @mebius-io/web
```

## Versioning & changelog

SemVer. Public API stabil per major version; perubahan breaking pada kontrak =
major bump serempak di semua platform Mebius. Lihat changeset di repo.

## License

MIT
