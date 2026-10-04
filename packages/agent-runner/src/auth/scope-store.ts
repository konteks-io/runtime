import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isFsErrorWithCode, writeSecretFile, type OwnershipScope } from "@konteks/remote-common";

/**
 * Per-agent ownership scope state, kept inside the private credential
 * volume next to the login it describes. Holds only the opaque keyed
 * fingerprint — never an account identifier — and the scope the operator
 * attested. Any fingerprint change resets the scope to `personal`.
 */
export const AgentScopeStateSchema = z
  .object({
    accountScope: z.enum(["personal", "organization"]),
    authIdentityFingerprint: z.string().min(1).nullable(),
    scopeAttestedAt: z.string().nullable(),
    lastLoginAt: z.string().nullable(),
  })
  .strict();
export type AgentScopeState = z.infer<typeof AgentScopeStateSchema>;

const SCOPE_FILE_NAME = "agent-scope.json";

type ScopeTransition =
  | { kind: "unchanged"; state: AgentScopeState }
  | { kind: "attested"; state: AgentScopeState }
  | { kind: "reset"; state: AgentScopeState; previousScope: OwnershipScope };

export const INITIAL_SCOPE_STATE: AgentScopeState = {
  accountScope: "personal",
  authIdentityFingerprint: null,
  scopeAttestedAt: null,
  lastLoginAt: null,
};

/**
 * Pure transition: the identity observed after a login/probe plus whether the
 * operator attested `--organization` for THIS login.
 */
export function applyIdentityObservation(
  state: AgentScopeState,
  observation: { fingerprint: string | null; organizationAttested: boolean; at: string; isLogin: boolean },
): ScopeTransition {
  let next: AgentScopeState = {
    ...state,
    authIdentityFingerprint: observation.fingerprint,
    ...(observation.isLogin ? { lastLoginAt: observation.at } : {}),
  };
  const lost = identityLost(state.authIdentityFingerprint, observation.fingerprint);
  const reset = lost && state.accountScope === "organization";
  if (lost) next = { ...next, accountScope: "personal", scopeAttestedAt: null };
  if (observation.organizationAttested && observation.fingerprint !== null) {
    next = { ...next, accountScope: "organization", scopeAttestedAt: observation.at };
    return { kind: "attested", state: next };
  }
  if (reset) return { kind: "reset", state: next, previousScope: "organization" };
  return { kind: "unchanged", state: next };
}

/** A known identity was replaced by another or signed out. */
function identityLost(previous: string | null, observed: string | null): boolean {
  return previous !== null && observed !== previous;
}

export class AgentScopeStore {
  constructor(private readonly credentialDir: string) {}

  private get path(): string {
    return join(this.credentialDir, SCOPE_FILE_NAME);
  }

  async read(): Promise<AgentScopeState> {
    try {
      return AgentScopeStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (isFsErrorWithCode(error, "ENOENT")) return INITIAL_SCOPE_STATE;
      // A corrupt scope file is treated as no attestation (fail to personal).
      return INITIAL_SCOPE_STATE;
    }
  }

  async write(state: AgentScopeState): Promise<void> {
    await writeSecretFile(this.path, `${JSON.stringify(AgentScopeStateSchema.parse(state))}\n`);
  }
}
