import type { MebiusErrorCode } from "./types.js";

/**
 * The single error type the SDK surfaces. Always uses Mebius terminology —
 * never raw transport/protocol wording.
 *
 * Inspect {@link MebiusError.code} to decide how to recover (for example,
 * refresh the token on `"TOKEN_EXPIRED"`).
 */
export class MebiusError extends Error {
  readonly code: MebiusErrorCode;
  /** The underlying cause, if any. Useful for logging, opaque to the contract. */
  readonly cause?: unknown;

  constructor(code: MebiusErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "MebiusError";
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, MebiusError.prototype);
  }
}

/** Human-readable default messages, kept in Mebius terms. */
const DEFAULT_MESSAGES: Record<MebiusErrorCode, string> = {
  TOKEN_EXPIRED: "Your Mebius token has expired. Mint a fresh token and reconnect.",
  PERMISSION_DENIED: "Camera/microphone permission was denied by the user or browser.",
  CONNECTION_FAILED: "Could not establish a connection to the Mebius gateway.",
  NOT_CONNECTED: "Not connected to Mebius. Call connect() before using this client.",
  STREAM_NOT_FOUND: "The requested stream could not be found on the Mebius gateway.",
  UNKNOWN: "An unexpected Mebius error occurred.",
};

/** Create a {@link MebiusError}, falling back to a sensible default message. */
export function mebiusError(
  code: MebiusErrorCode,
  message?: string,
  cause?: unknown,
): MebiusError {
  return new MebiusError(code, message ?? DEFAULT_MESSAGES[code], cause);
}
