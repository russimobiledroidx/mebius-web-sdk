import { describe, expect, it, beforeEach } from "vitest";
import { Mebius } from "./mebius.js";
import { MebiusError, mebiusError } from "./errors.js";
import { TypedEmitter } from "./events.js";
import { readToken } from "./internal/token.js";
import { createViewTransport } from "./internal/transport.js";
import { SignalingClient } from "./internal/signaling.js";

/** Build an unsigned JWT-shaped token with a given exp (seconds). */
function tokenWithExp(expSeconds: number | null): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify(expSeconds === null ? {} : { exp: expSeconds }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}

describe("MebiusError", () => {
  it("carries a Mebius code and default message", () => {
    const err = mebiusError("TOKEN_EXPIRED");
    expect(err).toBeInstanceOf(MebiusError);
    expect(err.code).toBe("TOKEN_EXPIRED");
    expect(err.message).toMatch(/token/i);
  });
});

describe("TypedEmitter", () => {
  class Emitter extends TypedEmitter<{ ping: number }> {
    fire(n: number) {
      this.emit("ping", n);
    }
  }

  it("delivers events and supports unsubscribe", () => {
    const e = new Emitter();
    const seen: number[] = [];
    const off = e.on("ping", (n) => seen.push(n));
    e.fire(1);
    off();
    e.fire(2);
    expect(seen).toEqual([1]);
  });
});

describe("readToken", () => {
  it("extracts exp in milliseconds", () => {
    const info = readToken(tokenWithExp(1000));
    expect(info.expiresAtMs).toBe(1_000_000);
  });
  it("returns null when no exp", () => {
    expect(readToken(tokenWithExp(null)).expiresAtMs).toBeNull();
    expect(readToken("not-a-jwt").expiresAtMs).toBeNull();
  });
});

describe("transport auto-selection", () => {
  const sig = new SignalingClient("https://gateway.example", "t");
  it("uses different transports per mode without exposing protocol names", () => {
    const ll = createViewTransport("low-latency", sig);
    const scale = createViewTransport("scale", sig);
    expect(ll.constructor).not.toBe(scale.constructor);
  });
});

describe("Mebius.init / connect", () => {
  beforeEach(() => Mebius._reset());

  it("requires init before connect", () => {
    expect(() => Mebius.connect({ token: "x" })).toThrow(MebiusError);
  });

  it("emits connected for a valid token", async () => {
    Mebius.init({ appId: "app", gateway: "https://gateway.example" });
    const client = Mebius.connect({ token: tokenWithExp(Math.floor(Date.now() / 1000) + 3600) });
    const connected = await new Promise<boolean>((resolve) => {
      client.on("connected", () => resolve(true));
      setTimeout(() => resolve(false), 50);
    });
    expect(connected).toBe(true);
  });

  it("emits TOKEN_EXPIRED error for an expired token", async () => {
    Mebius.init({ appId: "app", gateway: "https://gateway.example" });
    const client = Mebius.connect({ token: tokenWithExp(1) });
    const code = await new Promise<string>((resolve) => {
      client.on("error", (e) => resolve(e.code));
      setTimeout(() => resolve("none"), 50);
    });
    expect(code).toBe("TOKEN_EXPIRED");
  });
});
