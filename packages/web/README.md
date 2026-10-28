# @mebius-io/web

SDK web Mebius untuk live streaming — install, ikuti docs, hit API.

[![npm version](https://img.shields.io/badge/npm-%40mebius%2Fweb-blue)](https://www.npmjs.com/package/@mebius-io/web)
[![license](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

## Requirements

- Browser modern dengan WebRTC (Chrome, Edge, Firefox, Safari terbaru).
- **HTTPS wajib di production.** `localhost` boleh dipakai untuk development.
- Node 20+ hanya untuk build tooling (bukan runtime SDK).

## Install

Package sudah **live di npm registry** (public). Install seperti biasa:

```bash
npm i @mebius-io/web
# atau: pnpm add @mebius-io/web / yarn add @mebius-io/web
```

Package berisi `dist/` (ESM + CJS + UMD + types) dan menarik dependency runtime
playback-nya otomatis. Tidak perlu build di sisi consumer.

```ts
const { Mebius } = require("@mebius-io/web"); // CJS — works
import { Mebius } from "@mebius-io/web";       // ESM — works
```

Via CDN (UMD global `Mebius`):

```html
<script src="https://unpkg.com/@mebius-io/web/dist/index.global.js"></script>
<script>
  Mebius.Mebius.init({ appId: "app_123", gateway: "https://gateway.mebius.io" });
</script>
```

> Butuh install offline / tanpa registry? Lihat
> [Distribusi via tarball](#distribusi-via-tarball-offline--tanpa-registry).

### Single-file drop-in (PHP / plain HTML, no build)

For PHP or any plain-HTML project: download ONE self-contained file and add a
`<script>` tag — no npm, no bundler. The scale engine is bundled in; zero
external deps. `Mebius` becomes a global.

```html
<script src="mebius.min.js"></script>
<script>
  Mebius.init({ appId: "app_123", gateway: "https://gateway.mebius.io" });
  const client = Mebius.connect({ token, deliveries }); // dari backend kamu
</script>
```

File + full PHP example: [`standalone/`](./standalone/). Raw download:
`https://raw.githubusercontent.com/russimobiledroidx/mebius-web-sdk/v0.4.6/packages/web/standalone/mebius.min.js`

The drop-in file is not part of the npm package — `files` ships only `dist` — so it
is fetched from the tag, and the tag must match the version you installed. For a
page with a build step, or one that can use an import map, prefer the ESM path:
`https://esm.sh/@mebius-io/web@0.4.6`.

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
const player = client.createPlayer(); // mode default "auto"

player.on("playing", ({ streamId }) => console.log("playing", streamId));
player.on("buffering", () => console.log("buffering..."));
player.on("ended", () => console.log("ended"));

await player.play("my-stream", "#viewer"); // <video id="viewer">
player.setVolume(0.8);

await player.stop();
```

Mebius picks the delivery route and keeps watching it. A route that stops
delivering — an edge restarting, the publisher reconnecting, a second of lost
network — is reopened by the player itself: it emits `buffering`, walks the
route list again, and emits `playing` once a route is serving. Only after five
bounded attempts does it give up and emit `ended`. So an app does not need its
own restart loop for a long watch; handle `buffering`/`playing` for the spinner
and `ended` for the end.

### Mode playback

| Mode | Kapan dipakai |
| --- | --- |
| `"auto"` (default) | Rekomendasi. Mebius pilih rute per penonton, dan pindah sendiri kalau rute yang dipakai berhenti mengirim frame. |
| `"low-latency"` | Interaktif dua arah (mis. co-broadcast), delay sub-detik. Browser saja. |
| `"balanced"` | Delay rendah tapi tetap skala besar. Butuh browser dengan Media Source (bukan Safari iOS). |
| `"scale"` | Audiens paling besar, delay paling tinggi, jalan di semua platform termasuk Safari iOS. |

Ganti mode kapan saja dengan membuat player baru.

### Menonton lawan bicara (`createMonitor`)

Kalau kamu menonton stream yang sedang kamu **ajak interaksi** (sisi lain dari
co-broadcast), delay satu-dua detik membuat interaksinya terasa rusak:

```ts
const monitor = client.createMonitor();
await monitor.play(opponentStreamId, "#opponent");
```

Sama seperti player biasa, hanya budget delay-nya beda. Monitor mulai dari rute
real-time dan **pindah sendiri** kalau rute itu tidak mengirim frame dalam 8
detik — logika yang sebelumnya harus ditulis ulang di setiap aplikasi, dan kalau
salah hasilnya frame hitam di depan penonton live.

### `deliveries`

`Mebius.connect()` menerima `deliveries` yang dikirim backend bareng token:

```ts
const { token, deliveries } = await (await fetch("/api/mebius-token")).json();
const client = Mebius.connect({ token, deliveries });
```

Teruskan apa adanya — isinya opaque dan Mebius yang mengurutkan serta memilih.
Opsional: tanpa itu playback tetap jalan, tapi setiap penonton dilayani dari
origin Mebius, bukan edge terdekat.

### Kualitas (1080p / 720p / 540p / 480p)

Tenant yang di-transcode engine menerima `renditions` di entri `deliveries`
(`fast` dan `wide`). Teruskan `deliveries` apa adanya — SDK yang membaca ladder-nya:

```ts
player.on("qualities-changed", (qs) => renderMenu(qs)); // [] = sembunyikan menu
player.on("quality-changed", ({ id, auto }) => showLabel(auto ? `Auto (${id ?? "?"})` : id));

await player.play("my-stream", "#viewer");
player.qualities;              // [{ id: "1080p", label: "1080p", height: 1080, bitrateKbps: 6000 }, ...]
await player.setQuality("720p");
await player.setQuality("auto"); // default
player.setMaxQuality(720);     // "auto" tidak pernah naik di atas 720p; 0/null = tanpa cap
```

Membatasi rendition yang boleh diterima penonton (mis. paket tanpa full HD) —
contoh SportStream di web:

```ts
await player.setAllowedQualities(["540p", "480p"]); // sebelum atau sesudah play()
player.qualities;  // hanya rendition yang diizinkan → [{ id: "540p", ... }, { id: "480p", ... }]
await player.setAllowedQualities(null);             // null atau [] = semua
```

- `setAllowedQualities`: id yang tidak ada di ladder diabaikan; kalau tak satu pun
  cocok, semua diizinkan (stream tidak pernah kehilangan gambar). `qualities-changed`
  terbit kalau daftarnya berubah, `"auto"` tidak pernah keluar dari set ini, dan
  `setQuality` dengan id di luar set ditolak. Pilihan manual yang tidak lagi
  diizinkan kembali ke `"auto"`.
- Pilihan manual mengalahkan `setMaxQuality`; cap hanya membatasi `"auto"`.
- Kalau rendition yang dipilih ternyata tidak ada untuk stream ini (sumbernya lebih
  kecil), playback kembali ke `"auto"` — bukan gagal — dan `quality-changed`
  terbit dengan `auto: true`.
- Pilihan, cap, dan set yang diizinkan disimpan player, jadi tetap berlaku saat
  rute dibuka ulang (recovery/failover).
- `qualities` kosong kalau delivery tidak membawa `renditions` — perilaku playback
  persis seperti sebelumnya, dan semua method di atas tidak berpengaruh.
- `quality-changed`: `id` = rendition yang sedang tayang, `null` kalau rute tidak
  bisa menyebutnya (mis. ABR native Safari). Bisa terbit lebih dari sekali per pilihan.
- Rute `wide`: kualitas menyesuaikan jaringan secara kontinu; pilihan manual
  berpindah di tempat tanpa membuka ulang stream.
- Rute `fast`: `"auto"` mulai dari rendition tertinggi yang diizinkan ≤ cap dan
  turun satu tingkat (tidak di bawah yang terendah yang diizinkan) setelah 2 stall
  dalam 20 detik (tidak naik sendiri); pilihan manual membuka ulang stream di
  rendition itu (~1 detik, mute/volume tetap).
- Safari iOS: browser yang memilih kualitas di mode `"auto"`; pilihan manual atau
  cap di bawah rendition tertinggi mengunci satu rendition.

Untuk tenant ber-ladder pakai `createBroadcaster({ maxBitrateKbps: 6000 })`: di atas
default 2500 kbps, broadcaster juga meminta kamera 1920x1080@30 (`ideal`, kamera
lemah tetap jalan). Tanpa opsi itu capture dan bitrate persis seperti sebelumnya.

Profil encoder resmi dan kontrak `renditions`: stream-engine `docs/INTEGRATION.md`
§3.1 "Encoder profiles" dan §5.9 "Quality renditions".

### `beaconToken` / `beaconUrl` — quality di dashboard

Response token juga membawa dua field opsional. Teruskan keduanya dan SDK
melaporkan kualitas stream ini (bitrate, fps, rtt, jeda first-frame) tiap ~15
detik:

```ts
const { token, deliveries, beaconToken, beaconUrl } = await (await fetch("/api/mebius-token")).json();
const client = Mebius.connect({ token, deliveries, beaconToken, beaconUrl });
```

Itu yang mengisi **Quality → Publish / Play** di dashboard Mebius, dan yang jadi
dasar hitung **viewer minutes** — laporan sisi penonton adalah satu-satunya sumber
data itu, karena cuma client yang bisa melihat pengalaman penonton sebenarnya.

Aman di browser: kredensialnya terikat klaim bertanda tangan ke **satu** stream dan
**satu** project, jadi tak bisa dipakai menulis telemetri milik stream lain. SDK
tidak pernah tahu tenant-mu — informasi itu ada di dalam klaim, bukan di kode client.

Tanpa dua field itu stream tetap jalan normal; kamu hanya tidak melihat data
kualitasnya. Tambahkan `userId` di `connect()` kalau ingin laporan itu ikut membawa
id pengguna versimu.

## Screen share (lihat & kontrol layar)

Untuk app monitoring / remote support. Backend kamu (pakai `sk_` key) membuat
sesi lewat REST `/api/v1/screen/...` dan mengembalikan `{ sessionId, token, iceServers? }`
ke browser. Screen viewer dan screen share **tidak butuh** `Mebius.connect()`;
cukup `Mebius.init()`.

### Dashboard admin: lihat (dan kontrol) layar

```ts
import { Mebius } from "@mebius-io/web";

Mebius.init({ appId: "app_123", gateway: "https://stream.mebius.io" });

const { sessionId, token, iceServers } = await fetch(`/api/devices/${deviceId}/view`, {
  method: "POST",
  body: JSON.stringify({ mode: "control" }),
}).then((r) => r.json());

const viewer = Mebius.createScreenViewer();
viewer.on("ended", () => console.log("sesi selesai"));
viewer.on("error", (e) => console.warn(e.code, e.message));

// Retry sendiri ±15 detik selama device belum mulai mengirim layar. Resolve saat
// Mebius menerima viewer; gambar menyusul sesaat kemudian.
await viewer.watch({ sessionId, token, iceServers }, "#screen"); // <video id="screen" autoplay muted playsinline>

// Mode control saja. Mouse, wheel, keyboard di elemen video dikirim ke layar
// karyawan (keyboard aktif selama video fokus; klik video untuk fokus).
viewer.enableControl({
  refreshToken: async () =>
    (await (await fetch(`/api/sessions/${sessionId}/token`, { method: "POST" })).json()).token,
});

viewer.disableControl(); // tetap menonton
viewer.close();          // berhenti menonton; sesi berakhir sendiri 60 detik kemudian
```

- Koordinat dikirim sebagai pecahan 0–1 dari **gambar layar**, bukan elemen
  (bar hitam `object-fit: contain` tidak dihitung). Klik di bar diabaikan.
- Input dikirim per frame (maks 64 event per request). View token berlaku 10
  menit dan dicek di setiap input, jadi `refreshToken` dipanggil sebelum token
  habis, dan sekali lagi kalau Mebius menolak token.
- Selama video fokus, **semua** tombol dikirim ke layar karyawan, termasuk Tab
  dan Escape. Klik di luar video untuk mengembalikan keyboard ke halaman; tombol
  yang masih ditekan dilepas otomatis.
- Koneksi yang putus dibuka ulang sendiri. Kalau Mebius menolak (sesi sudah
  berakhir), viewer memancarkan `ended` lalu menutup diri. Tanpa mode control,
  view token tidak diperbarui, jadi koneksi yang putus setelah 10 menit juga
  berakhir dengan `ended`.
- Sesi `view` menolak input: `error` dengan `PERMISSION_DENIED`, lalu kontrol
  dimatikan otomatis.

### Karyawan: share layar dari browser (tanpa install)

```ts
const share = Mebius.createScreenShare(); // device secret disimpan di localStorage browser ini
await share.enrollIfNeeded(enrollCode);   // kode sekali pakai dari backend kamu

// Harus langsung dari klik: browser hanya menampilkan dialog pilih layar dari gesture user.
startButton.onclick = () => share.start(); // pilih layar, lalu device online
stopButton.onclick = () => share.stop();   // device offline

share.on("viewing", ({ sessionId, mode, userId }) => showBanner("Layar Anda sedang dilihat"));
share.on("ended", () => hideBanner());
share.on("stopped", () => showStartButton()); // juga saat user klik "Stop sharing" di browser
```

- Device hanya online selama share berjalan. Remote control tidak mungkin dari
  browser; sesi `control` ditayangkan seperti `view`.
- Simpan device secret di tempat lain dengan `createScreenShare({ credentials })`
  (`{ load, save, clear }`). Kalau data situs dihapus, enroll ulang dengan kode baru.
- Device yang dicabut: credential dihapus, `error` (`TOKEN_EXPIRED`), lalu `stopped`.

Broadcaster biasa juga bisa mengirim stream milik app sendiri (mis. hasil
`getDisplayMedia`): `client.createBroadcaster({ source: stream })`. Kamera dan
mikrofon tidak diminta, dan `stop()` tidak menghentikan `source` kamu.

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
  const { videoRef, play } = usePlayer(client, {});
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
    player = client.createPlayer();
    await player.play(streamId, video.value!);
  });
  onUnmounted(() => player?.stop());
  return { video };
}
```

### Vite

Tidak ada config khusus. ESM langsung jalan; engine playback per mode di-load
lazy hanya saat mode itu dipakai, jadi aplikasi yang cuma pakai `"low-latency"`
tidak membawa bundle mode lain.

## API Reference

| Class | Method | Return | Keterangan |
|---|---|---|---|
| `Mebius` | `init({ appId, gateway })` | `void` | Konfigurasi sekali di awal. |
| `Mebius` | `connect({ token, deliveries? })` | `MebiusClient` | Buka koneksi. |
| `MebiusClient` | `createBroadcaster({ video?, audio?, maxBitrateKbps? })` | `MebiusBroadcaster` | `maxBitrateKbps` default 2500. |
| `MebiusClient` | `createPlayer({ mode? })` | `MebiusPlayer` | `mode: "auto" \| "low-latency" \| "balanced" \| "scale"`, default `"auto"` |
| `MebiusClient` | `createMonitor()` | `MebiusPlayer` | Player untuk stream yang kamu ajak interaksi. |
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
| `MebiusPlayer` | `qualities` | `MebiusQuality[]` | Rendition yang benar-benar bisa dipilih. `[]` = satu rendition, sembunyikan menu kualitas. |
| `MebiusPlayer` | `setQuality("auto" \| id)` | `Promise<void>` | Tolak id di luar `qualities`; playback tidak terganggu. |
| `MebiusPlayer` | `setMaxQuality(height)` | `void` | Cap untuk `"auto"`, dalam piksel tinggi. `0`/`null` = tanpa cap. |
| `MebiusPlayer` | `setAllowedQualities(ids \| null)` | `Promise<void>` | Batasi rendition yang boleh diterima. `null`/`[]` = semua. |
| `Mebius` | `createScreenViewer()` | `MebiusScreenViewer` | Butuh `init()` saja. |
| `MebiusScreenViewer` | `watch({ sessionId, token, iceServers? }, viewTarget)` | `Promise<void>` | Retry ±15 detik sampai Mebius menerima viewer. |
| `MebiusScreenViewer` | `enableControl({ refreshToken })` / `disableControl()` | `void` | Sesi `control` saja. |
| `MebiusScreenViewer` | `close()` | `void` | |
| `Mebius` | `createScreenShare({ credentials? })` | `MebiusScreenShare` | Butuh `init()` saja. |
| `MebiusScreenShare` | `enrollIfNeeded(code, { name?, os? }?)` | `Promise<void>` | Default `name: "browser"`, `os: "web"`. |
| `MebiusScreenShare` | `start()` / `stop()` | `Promise<void>` | `start()` langsung dari klik. |

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
| player | `qualities-changed` | `MebiusQuality[]` | terbit sekali tiap rute playback diterima |
| screen viewer | `ended` | — |
| screen viewer | `error` | `MebiusError` |
| screen share | `viewing` | `{ sessionId, mode, userId }` |
| screen share | `ended` | `{ sessionId }` |
| screen share | `stopped` | — |
| screen share | `error` | `MebiusError` |
| player | `quality-changed` | `{ id: string \| null, auto }` | rendition yang tayang berubah (hanya kalau ada ladder) |

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

## Distribusi via tarball (offline / tanpa registry)

Package sudah live di npm (`npm i @mebius-io/web`). Bagian ini hanya untuk kasus
**offline / air-gapped** atau saat kamu sengaja tidak mau lewat registry.

```bash
# 1. Maintainer build + pack semua package sekaligus (di repo SDK):
pnpm pack:all
#   -> mebius-web-0.1.0.tgz
#      mebius-react-0.1.0.tgz
#      mebius-react-native-0.1.0.tgz   (di root repo)

# 2. Consumer install (copy .tgz ke project, lalu):
npm i ./mebius-web-0.1.0.tgz
```

`@mebius-io/web` self-contained (tanpa workspace dep), jadi paling bersih untuk
install tarball standalone.

### Cross-package dependency (react)

`@mebius-io/react` bergantung ke `@mebius-io/web`. Lewat npm registry ini otomatis
teratasi. Untuk **tarball offline**, `workspace:*` ditulis ulang jadi versi
konkret (`"@mebius-io/web": "0.1.0"`); install kedua tarball dalam satu perintah
agar dep-nya terpenuhi lokal:

```bash
npm i ./mebius-web-0.1.0.tgz ./mebius-react-0.1.0.tgz react
```

## Versioning & changelog

SemVer. Public API stabil per major version; perubahan breaking pada kontrak =
major bump serempak di semua platform Mebius. Lihat changeset di repo.

## License

MIT
