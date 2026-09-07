#!/usr/bin/env node
/**
 * Build the single-file, drop-in standalone bundle.
 *
 * Bundles EVERYTHING — including the scale-mode playback engine (hls.js) — into
 * one browser file with no external dependencies, so a PHP/plain-HTML project
 * can use it with just a <script> tag.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, statSync } from "node:fs";

// Same injection tsup.config.ts does. Without it this bundle reports "web/dev"
// as its version — and the standalone file is exactly the one used by projects
// that have no build step to tell us anything else about themselves.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

mkdirSync("standalone", { recursive: true });

const banner = {
  js: "/* Mebius Web SDK — standalone single-file build. https://github.com/russimobiledroidx/mebius-web-sdk */",
};

const common = {
  entryPoints: ["src/standalone.ts"],
  bundle: true, // pull hls.js and everything else inline — zero external deps
  format: "iife",
  platform: "browser",
  target: "es2017",
  legalComments: "none",
  banner,
  define: { __MEBIUS_SDK_VERSION__: JSON.stringify(version) },
};

await build({ ...common, outfile: "standalone/mebius.js", minify: false, sourcemap: false });
await build({ ...common, outfile: "standalone/mebius.min.js", minify: true, sourcemap: false });

const kb = (p) => Math.round(statSync(p).size / 1024);
console.log(`✓ standalone/mebius.js      ${kb("standalone/mebius.js")} KB`);
console.log(`✓ standalone/mebius.min.js  ${kb("standalone/mebius.min.js")} KB`);
