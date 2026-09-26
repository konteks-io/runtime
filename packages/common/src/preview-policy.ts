/**
 * The closed preview forwarding policy (D124/D125). Enforced independently by
 * the supervisor (on the channel) and the relay (CP9). The viewer can never name a host, carry a
 * credential, or use the channel as an open proxy.
 */
export const PREVIEW_REQUEST_HEADERS = Object.freeze([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "content-length",
  "cache-control",
  "if-none-match",
  "if-modified-since",
  "range",
  "sec-websocket-protocol",
  "sec-websocket-version",
] as const);

export const PREVIEW_RESPONSE_HEADERS = Object.freeze([
  "content-type",
  "content-length",
  "content-encoding",
  "cache-control",
  "etag",
  "last-modified",
  "content-range",
  "accept-ranges",
  "vary",
  "location",
  "sec-websocket-protocol",
  "sec-websocket-accept",
] as const);

export const PREVIEW_METHODS = Object.freeze([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const);
export type PreviewMethod = (typeof PREVIEW_METHODS)[number];

export const PREVIEW_CAPS = Object.freeze({
  maxHeaders: 32,
  maxHeaderNameBytes: 64,
  maxHeaderValueBytes: 4 * 1024,
  maxHeadersTotalBytes: 16 * 1024,
  maxPathBytes: 8 * 1024,
  maxRequestBodyBytes: 8 * 1024 * 1024,
  maxResponseBodyBytes: 64 * 1024 * 1024,
  maxWsFrameBytes: 1024 * 1024,
  maxChunkBytes: 256 * 1024,
  maxConcurrentStreams: 64,
  idleStreamTimeoutMs: 120_000,
});

export type HeaderPolicyMode = "sender" | "receiver";

export type HeaderPolicyResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; code: "preview_header_rejected"; reason: string };

const REQUEST_SET: ReadonlySet<string> = new Set(PREVIEW_REQUEST_HEADERS);
const RESPONSE_SET: ReadonlySet<string> = new Set(PREVIEW_RESPONSE_HEADERS);
const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/;
// eslint-disable-next-line no-control-regex
const PATH_CONTROL_BYTES = /[\x00-\x1f\x7f]/;
const PATH_SCHEME_PREFIX = /^\/[a-z][a-z0-9+.-]*:/i;

function applyHeaderPolicy(
  raw: Record<string, string | string[] | undefined>,
  allowed: ReadonlySet<string>,
  mode: HeaderPolicyMode,
): HeaderPolicyResult {
  const headers: Record<string, string> = {};
  let count = 0;
  let totalBytes = 0;
  for (const [rawName, rawValue] of Object.entries(raw)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    if (!allowed.has(name)) {
      if (mode === "receiver") {
        return { ok: false, code: "preview_header_rejected", reason: `header not allowed: ${name}` };
      }
      continue;
    }
    if (Buffer.byteLength(name) > PREVIEW_CAPS.maxHeaderNameBytes) {
      return { ok: false, code: "preview_header_rejected", reason: "header name too long" };
    }
    if (Buffer.byteLength(value) > PREVIEW_CAPS.maxHeaderValueBytes) {
      return { ok: false, code: "preview_header_rejected", reason: `header value too long: ${name}` };
    }
    if (HEADER_VALUE_FORBIDDEN.test(value)) {
      return { ok: false, code: "preview_header_rejected", reason: `header value malformed: ${name}` };
    }
    count += 1;
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (count > PREVIEW_CAPS.maxHeaders) {
      return { ok: false, code: "preview_header_rejected", reason: "too many headers" };
    }
    if (totalBytes > PREVIEW_CAPS.maxHeadersTotalBytes) {
      return { ok: false, code: "preview_header_rejected", reason: "headers too large" };
    }
    headers[name] = value;
  }
  return { ok: true, headers };
}

export function applyPreviewRequestHeaderPolicy(
  raw: Record<string, string | string[] | undefined>,
  mode: HeaderPolicyMode,
): HeaderPolicyResult {
  return applyHeaderPolicy(raw, REQUEST_SET, mode);
}

export function applyPreviewResponseHeaderPolicy(
  raw: Record<string, string | string[] | undefined>,
  mode: HeaderPolicyMode,
): HeaderPolicyResult {
  return applyHeaderPolicy(raw, RESPONSE_SET, mode);
}

export type PathPolicyResult =
  | { ok: true; path: string }
  | { ok: false; code: "preview_path_invalid"; reason: string };

/**
 * Origin-form only: begins with `/`, no scheme/authority/`//` prefix/userinfo/
 * fragment/raw control byte/`..` segment after RFC 3986 normalization; ≤ 8 KiB.
 */
export function validatePreviewPath(path: string): PathPolicyResult {
  if (Buffer.byteLength(path) > PREVIEW_CAPS.maxPathBytes) {
    return { ok: false, code: "preview_path_invalid", reason: "path too long" };
  }
  if (!path.startsWith("/") || path.startsWith("//")) {
    return { ok: false, code: "preview_path_invalid", reason: "path must be origin-form" };
  }
  if (PATH_CONTROL_BYTES.test(path)) {
    return { ok: false, code: "preview_path_invalid", reason: "path contains a control byte" };
  }
  if (path.includes("#")) {
    return { ok: false, code: "preview_path_invalid", reason: "path contains a fragment" };
  }
  if (PATH_SCHEME_PREFIX.test(path) || path.includes("@")) {
    return { ok: false, code: "preview_path_invalid", reason: "path contains a scheme or userinfo" };
  }
  const [rawPath, query] = splitQuery(path);
  const segments = rawPath.split("/");
  const normalized: string[] = [];
  for (const segment of segments.slice(1)) {
    const decoded = safeDecode(segment);
    if (decoded === null) {
      return { ok: false, code: "preview_path_invalid", reason: "path percent-encoding malformed" };
    }
    if (decoded === "..") {
      return { ok: false, code: "preview_path_invalid", reason: "path contains a dot-dot segment" };
    }
    if (decoded === ".") continue;
    if (decoded.includes("/") || decoded.includes("\\")) {
      return { ok: false, code: "preview_path_invalid", reason: "path segment encodes a separator" };
    }
    normalized.push(segment);
  }
  const trailingSlash = rawPath.endsWith("/") && normalized.length > 0 ? "/" : "";
  const rebuilt = `/${normalized.join("/")}${trailingSlash}`;
  return { ok: true, path: query === undefined ? rebuilt : `${rebuilt}?${query}` };
}

function splitQuery(path: string): [string, string | undefined] {
  const index = path.indexOf("?");
  return index === -1 ? [path, undefined] : [path.slice(0, index), path.slice(index + 1)];
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export type LocationRewrite =
  | { kind: "rewritten"; location: string }
  | { kind: "replace_with_502"; reason: string };

/**
 * A 3xx passes through with `location` rewritten to origin-form when it
 * targets the preview origin; an absolute `location` to any other origin is
 * replaced by a 502 to the viewer. Redirects are never followed.
 */
export function rewritePreviewLocation(location: string, previewOrigin: string): LocationRewrite {
  if (location.startsWith("/") && !location.startsWith("//")) {
    const validated = validatePreviewPath(location);
    return validated.ok
      ? { kind: "rewritten", location: validated.path }
      : { kind: "replace_with_502", reason: validated.reason };
  }
  let parsed: URL;
  try {
    parsed = new URL(location, previewOrigin);
  } catch {
    return { kind: "replace_with_502", reason: "location is not a valid URL" };
  }
  if (parsed.origin !== new URL(previewOrigin).origin) {
    return { kind: "replace_with_502", reason: "location targets another origin" };
  }
  const validated = validatePreviewPath(`${parsed.pathname}${parsed.search}`);
  return validated.ok
    ? { kind: "rewritten", location: validated.path }
    : { kind: "replace_with_502", reason: validated.reason };
}

export function isPreviewMethod(method: string): method is PreviewMethod {
  return (PREVIEW_METHODS as readonly string[]).includes(method);
}

export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}
