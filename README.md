# Mebius Web SDK (monorepo)

Mebius Client SDK untuk web — live streaming yang gampang dipakai. Install, ikut docs, hit API.

## Packages

| Package | Path | Deskripsi |
|---|---|---|
| [`@mebius-io/web`](packages/web) | `packages/web` | Core SDK, vanilla TypeScript (browser WebRTC). |
| [`@mebius-io/react`](packages/react) | `packages/react` | React hooks tipis di atas `@mebius-io/web`. |
| [`@mebius-io/react-native`](packages/react-native) | `packages/react-native` | Skeleton + bridge interface (native menyusul). |

## Develop

```bash
pnpm install
pnpm build
pnpm test
pnpm check:abstraction   # acceptance: tidak ada istilah protokol bocor ke API publik
```

Butuh Node 20+ dan pnpm 9+.

## Acceptance

Public API Mebius tidak pernah membocorkan detail transport. CI menjalankan
`pnpm check:abstraction` yang gagal kalau ada istilah protokol mentah di
`.d.ts`, README, atau source publik. Detail transport hanya hidup di
direktori `internal/`.

## License

MIT
