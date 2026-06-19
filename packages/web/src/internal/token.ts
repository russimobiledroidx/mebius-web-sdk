/**
 * INTERNAL — read (NOT verify) a Mebius token's expiry.
 *
 * The token is a short-lived JWT minted by the developer's backend. The client
 * never verifies it (only the gateway can) — it just peeks at `exp` so it can
 * proactively surface a TOKEN_EXPIRED error and let the app refresh.
 */
export interface TokenInfo {
  /** Expiry as a UNIX epoch in milliseconds, if present. */
  expiresAtMs: number | null;
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const b64 = padded + pad;
  if (typeof atob === "function") return atob(b64);
  // Node fallback (tests / SSR).
  return Buffer.from(b64, "base64").toString("binary");
}

export function readToken(token: string): TokenInfo {
  const parts = token.split(".");
  if (parts.length < 2) return { expiresAtMs: null };
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1] ?? "")) as { exp?: number };
    return { expiresAtMs: typeof payload.exp === "number" ? payload.exp * 1000 : null };
  } catch {
    return { expiresAtMs: null };
  }
}
