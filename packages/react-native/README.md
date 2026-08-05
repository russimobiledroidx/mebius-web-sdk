# @mebius-io/react-native

Skeleton Mebius Client SDK untuk React Native. Mengekspos API surface kanonik
yang sama seperti [`@mebius-io/web`](../web); kerja sesungguhnya didelegasikan ke
**native bridge** (iOS/Android) yang menyusul.

[![npm version](https://img.shields.io/badge/npm-%40mebius%2Freact--native-blue)](https://www.npmjs.com/package/@mebius-io/react-native)
[![license](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

> Status: **skeleton**. Tanpa native module terpasang, pemanggilan API melempar
> `MebiusError` dengan code `NOT_IMPLEMENTED` — sinyal jelas, bukan no-op diam.

## Install

Sudah **live di npm** (public). Tanpa dependency internal, jadi install
standalone:

```bash
npm i @mebius-io/react-native react react-native
# atau: pnpm add @mebius-io/react-native react react-native
```

> Butuh install offline / tanpa registry? Pakai tarball
> (`pnpm --filter @mebius-io/react-native pack` → `npm i ./mebius-react-native-0.1.0.tgz`).
> Detail di README [`@mebius-io/web`](../web#distribusi-via-tarball-offline--tanpa-registry).

## Bridge interface

Native module wajib mengimplementasikan `MebiusNativeBridge` dan memanggil
`registerNativeBridge(bridge)` saat load. Kontrak (ringkas):

```ts
import { registerNativeBridge, type MebiusNativeBridge } from "@mebius-io/react-native";

const bridge: MebiusNativeBridge = {
  init, connect, disconnect,
  createBroadcaster, broadcasterStart, broadcasterStop,
  broadcasterSwitchCamera, broadcasterSetMicEnabled, broadcasterSetCameraEnabled,
  createPlayer, playerPlay, playerStop, playerSetVolume,
  addListener,
};
registerNativeBridge(bridge);
```

Detail transport ditentukan sepenuhnya di sisi native — tidak ada istilah
protokol yang bocor ke JS.

## API (target)

```ts
import { Mebius } from "@mebius-io/react-native";

Mebius.init({ appId, gateway });
const client = await Mebius.connect({ token });

const b = await client.createBroadcaster({ video: true, audio: true });
await b.start("my-stream");

const p = await client.createPlayer({ mode: "low-latency" });
await p.play("my-stream", viewTag);
```

Konsep inti (auth/token, mode low-latency vs scale, error code) sama dengan
`@mebius-io/web` — lihat README-nya.

## `deliveries` / `beaconToken` / `beaconUrl`

Semuanya dari response token yang sama:

```ts
const { token, deliveries, beaconToken, beaconUrl } = await getToken();
const client = await Mebius.connect({ token, deliveries, beaconToken, beaconUrl });
```

- `deliveries` — rute playback pilihan gateway. Di mobile ini beda antara biaya
  per-penonton dan tanpa biaya per-penonton, jadi kirim kalau ada.
- `beaconToken` + `beaconUrl` — melaporkan bahwa sesi ini hidup, yang jadi dasar
  hitung **viewer minutes**. Tanpa keduanya penonton React Native terhitung nol.
  Tambah `userId` kalau ingin laporan membawa id penggunamu.

**Metrik kualitas belum ada di platform ini.** Package ini tak punya permukaan
stats — native bridge tak mengekspos `getStats` dan tak ada event `stats` — jadi
tak ada angka bitrate/fps/rtt yang nyata untuk dikirim. Kolom quality di dashboard
dibiarkan kosong, bukan diisi angka karangan; watch time tetap terhitung.

## License

MIT
