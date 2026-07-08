# Publishing the Mebius Web SDK

This monorepo publishes three public npm packages (kept in lockstep via
Changesets, `fixed` group):

- `@mebius/web` — core browser SDK
- `@mebius/react` — React hooks (depends on `@mebius/web`)
- `@mebius/react-native` — React Native bindings

All three currently sit at `0.1.0`.

## One-time setup

1. **Own the `@mebius` scope on npm.** The packages are scoped `@mebius/*`, so an
   npm **organization named `mebius`** must exist and your account must belong to
   it. Create it (Free plan = unlimited public packages) at
   <https://www.npmjs.com/org/create>.
   - Alternative: rename the scope to a scope you already own (e.g. your
     username scope) in each `packages/*/package.json` and in
     `.changeset/config.json`.

2. **Create an npm Automation token.** npmjs.com → *Access Tokens* →
   *Generate New Token* → **Automation** (works with 2FA in CI). Copy it once.

## Option A — Publish from CI (recommended)

1. Add the token as a GitHub Actions secret named **`NPM_TOKEN`**:
   repo → *Settings → Secrets and variables → Actions → New repository secret*.
2. Push to `main` (or *Actions* → latest CI run → *Re-run all jobs*).
3. The `publish` job runs `pnpm release` (`turbo run build && changeset publish`)
   and publishes every package whose version is not yet on npm.

The publish job is guarded: it is skipped (CI stays green) until `NPM_TOKEN`
is set. See `.github/workflows/ci.yml`.

## Option B — Publish locally

```bash
npm login                 # or export NODE_AUTH_TOKEN=<automation-token>
pnpm install
pnpm release              # build + changeset publish (public access)
```

## Verify

```bash
npm view @mebius/web version          # -> 0.1.0
npm install @mebius/web               # works standalone; hls.js is pulled in
                                      # automatically as an internal dependency
```

Consumers never install or import `hls.js` / `flv.js` / `mpegts.js` directly —
the transport is chosen internally from the `PlaybackMode`
(`"low-latency" | "balanced" | "scale"`).

## Cutting a new version

```bash
pnpm changeset            # describe the change (choose bump level)
pnpm version-packages     # applies versions + changelog
git commit -am "version packages" && git push   # CI publishes on main
```
