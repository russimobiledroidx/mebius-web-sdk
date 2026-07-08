/**
 * Minimal internal smoke test for @mebius-io/web.
 *
 * Point GATEWAY at a running Mebius gateway (or a dummy gateway during dev) and
 * supply a token from your backend. This file exercises the full public API
 * surface without ever touching transport details.
 */
import { Mebius } from "@mebius-io/web";

const APP_ID = "app_demo";
const GATEWAY = "http://localhost:8787"; // dummy gateway for local dev
const STREAM_ID = "demo-stream";

// In a real app this comes from YOUR backend. Never embed an app secret here.
async function getToken(): Promise<string> {
  return "REPLACE_WITH_TOKEN_FROM_BACKEND";
}

const $ = (id: string) => document.getElementById(id)!;

async function main() {
  Mebius.init({ appId: APP_ID, gateway: GATEWAY });
  const client = Mebius.connect({ token: await getToken() });

  client.on("connected", () => console.log("[mebius] connected"));
  client.on("error", (e) => console.warn("[mebius] error", e.code, e.message));

  const broadcaster = client.createBroadcaster({ video: true, audio: true });
  broadcaster.on("stats", (s) => console.log("[broadcast]", s));

  $("go-live").addEventListener("click", async () => {
    await broadcaster.start(STREAM_ID);
    broadcaster.attachPreview("#preview");
  });
  $("stop-live").addEventListener("click", () => broadcaster.stop());
  $("flip").addEventListener("click", () => broadcaster.switchCamera());

  const player = client.createPlayer({ mode: "low-latency" });
  player.on("playing", () => console.log("[watch] playing"));
  $("play").addEventListener("click", () => player.play(STREAM_ID, "#viewer"));
  $("stop-play").addEventListener("click", () => player.stop());
}

void main();
