#!/usr/bin/env node
/**
 * Build the single-file, drop-in standalone bundle (ZegoExpress-style).
 *
 * Bundles EVERYTHING — including the scale-mode playback engine (hls.js) — into
 * one browser file with no external dependencies, so a PHP/plain-HTML project
 * can use it with just a <script> tag.
 */
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";

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
};

await build({ ...common, outfile: "standalone/mebius.js", minify: false, sourcemap: false });
await build({ ...common, outfile: "standalone/mebius.min.js", minify: true, sourcemap: false });

const kb = (p) => Math.round(statSync(p).size / 1024);
console.log(`✓ standalone/mebius.js      ${kb("standalone/mebius.js")} KB`);
console.log(`✓ standalone/mebius.min.js  ${kb("standalone/mebius.min.js")} KB`);
