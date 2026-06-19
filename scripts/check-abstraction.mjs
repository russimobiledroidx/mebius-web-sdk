#!/usr/bin/env node
/**
 * Abstraction guard (acceptance check).
 *
 * The Mebius public surface must never leak transport-protocol terms.
 * This script scans every PUBLIC artifact — published declaration files
 * (.d.ts), READMEs, and non-internal source — for forbidden tokens and
 * fails the build if any are found.
 *
 * Files under an `internal/` directory are the ONLY place these terms are
 * allowed, because they are private and never bundled into the public API.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Whole-word match so "showcase" etc. never trips "HLS"/"FLV".
const FORBIDDEN = /\b(WHIP|WHEP|HLS|MediaMTX|FLV)\b/;

const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".html"]);
const SKIP_DIR = new Set(["node_modules", ".turbo", ".git", "coverage"]);

/** Public artifacts only: published types, docs, and non-internal source. */
function isPublicArtifact(path) {
  // Anything inside an internal/ folder is private — protocol terms allowed.
  if (path.split(sep).includes("internal")) return false;
  // This guard script itself documents the forbidden words.
  if (path.endsWith(join("scripts", "check-abstraction.mjs"))) return false;
  // The canonical spec intentionally documents the abstraction rules.
  if (path.endsWith("MEBIUS_SDK_SPEC.md")) return false;
  // In build output, only the published type declarations are public surface.
  // Bundled .js/.map are implementation and are not part of the API contract.
  if (path.split(sep).includes("dist")) return path.endsWith(".d.ts");
  // The single-file standalone bundle inlines third-party code (the scale-mode
  // engine), which legitimately contains protocol strings — it is compiled
  // output, not the API contract, so only its docs are scanned, not the .js.
  if (path.split(sep).includes("standalone") && !path.endsWith(".md")) return false;
  return true;
}

/** @type {string[]} */
const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SKIP_DIR.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    const dot = entry.lastIndexOf(".");
    const ext = dot === -1 ? "" : entry.slice(dot);
    if (!SCAN_EXT.has(ext)) continue;
    if (!isPublicArtifact(full)) continue;

    const text = readFileSync(full, "utf8");
    text.split("\n").forEach((line, i) => {
      const m = line.match(FORBIDDEN);
      if (m) violations.push(`${full}:${i + 1}: leaked "${m[0]}" -> ${line.trim()}`);
    });
  }
}

walk(join(ROOT, "packages"));
walk(join(ROOT, "examples"));

if (violations.length > 0) {
  console.error("✗ Abstraction guard FAILED — protocol terms leaked into public surface:\n");
  for (const v of violations) console.error("  " + v);
  console.error(`\n${violations.length} violation(s). These terms must stay inside internal/.`);
  process.exit(1);
}

console.log("✓ Abstraction guard passed — no protocol terms in public surface.");
