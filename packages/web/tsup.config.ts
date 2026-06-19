import { defineConfig } from "tsup";

export default defineConfig({
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
