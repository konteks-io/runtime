import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * What the connector's loopback HTTP servers share (the MCP facade, the
 * preview tools, the turn result tool): a bounded body read, the per-session
 * bearer check and JSON answers.
 */

/** The request body, refused once it grows past `limit` bytes. */
export async function readBounded(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The body parsed as JSON; null when it is not JSON or is larger than `limit`. */
export async function readJsonBody(request: IncomingMessage, limit: number): Promise<{ value: unknown } | null> {
  try {
    return { value: JSON.parse((await readBounded(request, limit)).toString("utf8")) };
  } catch {
    return null;
  }
}

/** `Authorization: Bearer <credential>`, compared in constant time. */
export function bearerMatches(header: string | undefined, credential: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice(7));
  const expected = Buffer.from(credential);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

/** The MCP protocol version a client asked for when this server speaks it, else the newest it speaks. */
export function negotiatedProtocolVersion(params: unknown, supported: readonly string[]): string {
  const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
  return typeof asked === "string" && supported.includes(asked) ? asked : supported[0]!;
}
