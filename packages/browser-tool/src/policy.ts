import { z } from "zod";

/**
 * What the browser tool will navigate to. The container has no provider
 * route by network; this policy additionally refuses non-HTTP schemes and,
 * when configured, restricts targets to the preview origins the runtime
 * itself serves. Never a file:, chrome:, or javascript: target.
 */
export const BrowserToolPolicySchema = z
  .object({
    allowedOrigins: z.array(z.string().url()).default([]),
    maxScreenshotBytes: z.number().int().positive().default(4 * 1024 * 1024),
    maxSnapshotChars: z.number().int().positive().default(200_000),
    navigationTimeoutMs: z.number().int().positive().default(30_000),
    maxContexts: z.number().int().positive().default(8),
  })
  .strict();
export type BrowserToolPolicy = z.infer<typeof BrowserToolPolicySchema>;

export type NavigationDecision = { ok: true; url: URL } | { ok: false; reason: string };

export function decideNavigation(policy: BrowserToolPolicy, target: string): NavigationDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, reason: "target is not an absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme not allowed: ${url.protocol}` };
  }
  if (url.username || url.password) return { ok: false, reason: "userinfo is not allowed" };
  if (policy.allowedOrigins.length > 0 && !policy.allowedOrigins.some((origin) => new URL(origin).origin === url.origin)) {
    return { ok: false, reason: "origin is not in the allowed preview origins" };
  }
  return { ok: true, url };
}
