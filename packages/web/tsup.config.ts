import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Read at build time. SDK_VERSION used to be a hand-written string and had been
// wrong for three releases — telemetry attributed every session to a version
// that had not shipped in months, which is worse than reporting nothing because
// it looks like an answer. There is exactly one version of this package and
// package.json holds it, so nobody has to remember to update a second copy.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: { __MEBIUS_SDK_VERSION__: JSON.stringify(version) },
  entry: ["src/index.ts"],
  format: ["esm", "cjs", "iife"],
  globalName: "Mebius",
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  target: "es2020",
  // hls.js is loaded lazily at runtime only when the "scale" playback mode is
  // used, so keep it out of the bundle.
  external: ["hls.js"],
  outExtension({ format }) {
    if (format === "cjs") return { js: ".cjs" };
    if (format === "iife") return { js: ".global.js" };
    return { js: ".js" };
  },
});
