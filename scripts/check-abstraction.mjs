#!/usr/bin/env node
/**
 * Abstraction guard (acceptance check).
 *
 * The Mebius public surface must never leak transport-protocol terms — clients
 * must only ever see Mebius vocabulary, never HLS / FLV / WHIP / WHEP /
 * mpegts.js / RTMP / m3u8. This script scans the CLIENT-FACING artifacts and
 * fails the build if any forbidden token is found.
 *
 * Two levels:
 *   - STRICT (case-insensitive): applied to what a client actually consumes —
 *     published type declarations (dist/**\/*.d.ts), package README.md, and the
 *     standalone drop-in docs. Catches lowercase leaks like `hls.js`, `whep`,
 *     `index.m3u8`.
 *   - LENIENT (case-sensitive acronyms): applied to non-internal source as an
 *     early warning. Source implements the protocols, so only the loud, prose
 *     acronyms are flagged here; the authoritative check is STRICT on the
 *     shipped surface.
 *
 * `internal/` folders are always exempt (private, never bundled). Tests, build
 * configs, changelogs, and maintainer docs are dev-only (not shipped to
 * clients) and are exempt too.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// STRICT: client-consumed surface. Note `srt`/`rtmp`/`mpegts`/`m3u8` and the
// `.js` engine names are matched too. WebRTC/SDP are intentionally NOT here:
// react-native-webrtc is a required peer dependency the developer installs, and
// SDP appears only in that peer library's own type shape — neither is a Mebius
// delivery term the client codes against.
const STRICT = /\b(whip|whep|hls|flv|mediamtx|mpegts|rtmp|srt|m3u8)\b/i;
// LENIENT: loud protocol acronyms in prose (case-sensitive) for source files.
const LENIENT = /\b(WHIP|WHEP|HLS|MediaMTX|FLV|RTMP|SRT)\b|mpegts/;

// `.json` is scanned because package.json is part of the client-facing surface:
// an optional peerDependency named after a vendor player (e.g. flv.js) tells the
// integrator exactly which transport library to install, defeating the whole
// abstraction. Lockfiles are excluded below — they list the transitive tree,
// which legitimately contains those names and is not authored by us.
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".html", ".json"]);
const SKIP_DIR = new Set(["node_modules", ".turbo", ".git", "coverage"]);

// Lockfiles / tsconfigs: machine-generated or tooling-only, never read by an
// integrator as documentation of our API.
const SKIP_FILE = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "turbo.json",
]);

/** True for files a client actually consumes (STRICT applies). */
function isClientSurface(path) {
  if (path.split(sep).includes("dist")) return path.endsWith(".d.ts");
  const name = basename(path);
  if (name === "README.md") return true;
  if (path.split(sep).includes("standalone") && name.endsWith(".md")) return true;
  return false;
}

/**
 * package.json gets a structural check rather than a line regex.
 *
 * The distinction that matters is who types the name:
 *   - `dependencies` are resolved and bundled for the integrator. They never
 *     appear in integrator code or install commands, so a transport library
 *     there is an implementation detail, not a leaked contract.
 *   - `peerDependencies` MUST be installed by the integrator, by name. A
 *     vendor player listed there tells them exactly which transport we use —
 *     that is a leak, and an optional peer dep is the sneakiest form of it
 *     because nothing fails without it.
 *   - `description` / `keywords` are marketing copy shown on npm.
 */
function packageJsonViolations(path) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return []; // malformed JSON is a different tool's problem
  }
  const out = [];
  const flag = (where, text) => {
    const m = String(text).match(STRICT);
    if (m) out.push(`${path}: leaked "${m[0]}" in ${where} -> ${text}`);
  };

  for (const dep of Object.keys(pkg.peerDependencies ?? {})) flag("peerDependencies", dep);
  for (const dep of Object.keys(pkg.peerDependenciesMeta ?? {})) flag("peerDependenciesMeta", dep);
  if (pkg.description) flag("description", pkg.description);
  for (const kw of pkg.keywords ?? []) flag("keywords", kw);
  return out;
}

/** Public artifacts to scan at all. Dev-only / maintainer files are excluded. */
function isScanned(path) {
  const parts = path.split(sep);
  const name = basename(path);
  // Lockfiles / tooling configs: generated, not our authored surface.
  if (SKIP_FILE.has(name)) return false;
  // Private implementation — protocol terms allowed.
  if (parts.includes("internal")) return false;
  // This guard documents the forbidden words.
  if (path.endsWith(join("scripts", "check-abstraction.mjs"))) return false;
  // Maintainer / spec docs — not shipped to clients.
  if (name === "MEBIUS_SDK_SPEC.md" || name === "PUBLISHING.md" || name === "CHANGELOG.md") return false;
  // Dev-only: tests and build/tooling configs are never shipped.
  if (/\.(test|spec)\.[tj]sx?$/.test(name)) return false;
  if (/\.config\.[tjm]s?$/.test(name) || name.endsWith(".config.mjs")) return false;
  // In build output, only published type declarations are the API contract.
  if (parts.includes("dist")) return path.endsWith(".d.ts");
  // The single-file standalone bundle inlines third-party code (protocol
  // strings are legitimate in compiled output); scan only its docs.
  if (parts.includes("standalone") && !path.endsWith(".md")) return false;
  return true;
}

/** @type {string[]} */
const violations = [];

/** Scan the files directly inside `dir`, without descending into it. */
function walkFilesOnly(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SKIP_DIR.has(entry)) continue;
    if (statSync(full).isDirectory()) continue;
    const dot = entry.lastIndexOf(".");
    const ext = dot === -1 ? "" : entry.slice(dot);
    if (!SCAN_EXT.has(ext)) continue;
    if (!isScanned(full)) continue;

    if (basename(full) === "package.json") {
      violations.push(...packageJsonViolations(full));
      continue;
    }

    const re = isClientSurface(full) ? STRICT : LENIENT;
    readFileSync(full, "utf8").split("\n").forEach((line, i) => {
      const m = line.match(re);
      if (m) violations.push(`${full}:${i + 1}: leaked "${m[0]}" -> ${line.trim()}`);
    });
  }
}

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
    if (!isScanned(full)) continue;

    if (entry === "package.json") {
      violations.push(...packageJsonViolations(full));
      continue;
    }

    const re = isClientSurface(full) ? STRICT : LENIENT;
    const text = readFileSync(full, "utf8");
    text.split("\n").forEach((line, i) => {
      const m = line.match(re);
      if (m) violations.push(`${full}:${i + 1}: leaked "${m[0]}" -> ${line.trim()}`);
    });
  }
}

walk(join(ROOT, "packages"));
walk(join(ROOT, "examples"));
// Root-level docs. The repo README is the npm landing page and the GitHub front
// page — the single most client-facing document there is — and it was previously
// unscanned entirely (it leaked "HLS").
walkFilesOnly(ROOT);

if (violations.length > 0) {
  console.error("✗ Abstraction guard FAILED — protocol terms leaked into public surface:\n");
  for (const v of violations) console.error("  " + v);
  console.error(`\n${violations.length} violation(s). These terms must stay inside internal/.`);
  process.exit(1);
}

console.log("✓ Abstraction guard passed — no protocol terms in client-facing surface.");
