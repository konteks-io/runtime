import type { Readable } from "node:stream";
import { setupError, setupText } from "../setup-locale.js";

const MAX_BYTES = 4_098;
const invalid = () => setupError("activation_invalid", "inputLength", { label: setupText("oneTimeCode") });

/** Explicit pipe only: no echo, argument, environment lookup, file, or producer error in output. */
export async function readActivationCodePipe(input: Readable & { isTTY?: boolean } = process.stdin): Promise<string> {
  if (input.isTTY) throw invalid();
  const bytes = Buffer.alloc(MAX_BYTES);
  let length = 0;
  const timeout = setTimeout(() => input.destroy(), 60_000);
  try {
    for await (const chunk of input) {
      const part = inputBytes(chunk);
      if (length + part.length > MAX_BYTES) throw invalid();
      part.copy(bytes, length);
      length += part.length;
    }
    // A pipe must close normally. Destroy/timeout must never admit a partial code.
    if (!input.readableEnded) throw invalid();
    const code = bytes.subarray(0, length).toString("utf8").replace(/\r?\n$/, "");
    if (!validCode(code)) throw invalid();
    return code;
  } catch {
    throw invalid();
  } finally {
    clearTimeout(timeout);
    bytes.fill(0);
    input.destroy();
  }
}

function inputBytes(chunk: string | Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function validCode(code: string): boolean {
  return code.length >= 8 && code.length <= 4_096 && [...code].every(character => character.charCodeAt(0) >= 33 && character.charCodeAt(0) <= 126);
}
