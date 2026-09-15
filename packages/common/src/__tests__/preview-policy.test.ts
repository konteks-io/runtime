import { describe, expect, it } from "vitest";
import {
  PREVIEW_CAPS,
  applyPreviewRequestHeaderPolicy,
  applyPreviewResponseHeaderPolicy,
  rewritePreviewLocation,
  validatePreviewPath,
} from "../preview-policy.js";

describe("preview header policy (D125)", () => {
  it("lowercases and keeps only allowlisted request headers as a sender", () => {
    const result = applyPreviewRequestHeaderPolicy(
      {
        Accept: "text/html",
        Cookie: "a=b",
        Authorization: "Bearer x",
        "X-Forwarded-For": "1.1.1.1",
        Host: "evil",
      },
      "sender",
    );
    expect(result).toEqual({ ok: true, headers: { accept: "text/html" } });
  });

  it("rejects a forbidden header as a receiver", () => {
    const result = applyPreviewRequestHeaderPolicy({ accept: "*/*", cookie: "a=b" }, "receiver");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("preview_header_rejected");
  });

  it.each([
    "authorization",
    "set-cookie",
    "host",
    "origin",
    "referer",
    "x-forwarded-proto",
    "forwarded",
    "proxy-authorization",
    "connection",
    "upgrade",
    "transfer-encoding",
    "te",
    "trailer",
    "keep-alive",
    "x-custom",
  ])("never lets %s through in either direction", (name) => {
    expect(applyPreviewRequestHeaderPolicy({ [name]: "v" }, "sender")).toEqual({
      ok: true,
      headers: {},
    });
    expect(applyPreviewResponseHeaderPolicy({ [name]: "v" }, "sender")).toEqual({
      ok: true,
      headers: {},
    });
    expect(applyPreviewRequestHeaderPolicy({ [name]: "v" }, "receiver").ok).toBe(false);
    expect(applyPreviewResponseHeaderPolicy({ [name]: "v" }, "receiver").ok).toBe(false);
  });

  it("enforces value and malformed-value caps", () => {
    expect(
      applyPreviewRequestHeaderPolicy(
        { accept: "x".repeat(PREVIEW_CAPS.maxHeaderValueBytes + 1) },
        "sender",
      ).ok,
    ).toBe(false);
    expect(applyPreviewResponseHeaderPolicy({ etag: "a\r\nb" }, "sender").ok).toBe(false);
  });
});

describe("preview path policy", () => {
  it.each(["/", "/index.html", "/a/b?c=d", "/a%20b/", "/./x"])("accepts origin-form %s", (path) => {
    expect(validatePreviewPath(path).ok).toBe(true);
  });

  it.each([
    "//evil.example/x",
    "http://evil.example/",
    "/a/../etc/passwd",
    "/a/%2e%2e/x",
    "/user@host",
    "/a#frag",
    "/ab",
    "relative",
    "/%2Fetc",
  ])("rejects %s", (path) => {
    const result = validatePreviewPath(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("preview_path_invalid");
  });

  it("rejects paths over 8 KiB", () => {
    expect(validatePreviewPath(`/${"a".repeat(PREVIEW_CAPS.maxPathBytes)}`).ok).toBe(false);
  });
});

describe("location rewriting", () => {
  const origin = "http://127.0.0.1:5173";
  it("rewrites an absolute location on the preview origin to origin-form", () => {
    expect(rewritePreviewLocation(`${origin}/next?x=1`, origin)).toEqual({
      kind: "rewritten",
      location: "/next?x=1",
    });
  });
  it("keeps a relative origin-form location", () => {
    expect(rewritePreviewLocation("/login", origin)).toEqual({ kind: "rewritten", location: "/login" });
  });
  it("replaces a cross-origin location with a 502", () => {
    expect(rewritePreviewLocation("https://accounts.example/login", origin).kind).toBe(
      "replace_with_502",
    );
    expect(rewritePreviewLocation("//other.example/x", origin).kind).toBe("replace_with_502");
  });
});
