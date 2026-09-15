import { z } from "zod";
import { RemoteInstanceError } from "@konteks/remote-common";
import type { ProviderId } from "./dialects/types.js";

/**
 * The signed egress allowlist: the only provider destinations a keyed runner
 * may reach, by provider, exact host, and path prefix. It arrives inside the
 * release manifest the launcher verified against the embedded root; the
 * gateway re-parses it strictly and refuses to start without one. The
 * desired-configuration `egressAllowlistRevision` must name THIS revision or
 * the configuration is acknowledged `rejected(unsupported_revision)`.
 */
export const EgressAllowlistSchema = z
  .object({
    revision: z.string().min(1).max(64),
    entries: z
      .array(
        z
          .object({
            provider: z.enum(["anthropic", "openai", "google", "deepseek"]),
            hosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).min(1),
            pathPrefixes: z.array(z.string().startsWith("/")).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type EgressAllowlist = z.infer<typeof EgressAllowlistSchema>;

export interface EgressMatch {
  provider: ProviderId;
  host: string;
  path: string;
}

export class EgressAllowlistIndex {
  private readonly byProvider = new Map<ProviderId, EgressAllowlist["entries"][number]>();

  constructor(readonly allowlist: EgressAllowlist) {
    for (const entry of allowlist.entries) {
      if (this.byProvider.has(entry.provider)) {
        throw new RemoteInstanceError("configuration_stale", `egress allowlist repeats provider ${entry.provider}`);
      }
      this.byProvider.set(entry.provider, entry);
    }
  }

  get revision(): string {
    return this.allowlist.revision;
  }

  providers(): ProviderId[] {
    return [...this.byProvider.keys()];
  }

  /**
   * Resolves a provider + agent-supplied path to an allowed upstream. The
   * agent never names a host: the host comes from the allowlist entry. The
   * path must start with an allowed prefix after normalization (no `..`,
   * no scheme, no `//`).
   */
  match(provider: string, path: string): EgressMatch | null {
    const entry = this.byProvider.get(provider as ProviderId);
    if (!entry) return null;
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || /[\r\n\0]/.test(path)) return null;
    const pathOnly = path.split("?")[0] ?? path;
    if (!entry.pathPrefixes.some((prefix) => pathOnly === prefix || pathOnly.startsWith(prefix))) return null;
    const host = entry.hosts[0];
    if (!host) return null;
    return { provider: entry.provider, host, path };
  }
}
