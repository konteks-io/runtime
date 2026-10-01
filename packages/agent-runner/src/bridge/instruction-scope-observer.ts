interface InstructionScopeV2 {
  version: 2;
  settings: "project";
  ancestors: "excluded";
  user: "excluded";
  local: "excluded";
  autoMemory: "excluded";
  auth: "official_profile";
  exclusionCount: number;
}

/** Stage 0 (S0-1): the bridge also runs no repository hooks and loads only the MCP servers Konteks gave the session. */
interface InstructionScopeV3 extends Omit<InstructionScopeV2, "version"> {
  version: 3;
  hooks: "disabled";
  repositoryMcp: "excluded";
  accountConnectors: "excluded";
}

type InstructionScope = InstructionScopeV2 | InstructionScopeV3;

const V2 = /^\[konteks\] instruction_scope version=2 settings=project ancestors=excluded user=excluded local=excluded auto_memory=excluded auth=official_profile exclusions=(\d{1,4})\r?\n$/;
const V3 = /^\[konteks\] instruction_scope version=3 settings=project ancestors=excluded user=excluded local=excluded auto_memory=excluded auth=official_profile exclusions=(\d{1,4}) hooks=disabled repository_mcp=excluded account_connectors=excluded\r?\n$/;

/** Decode only the signed bridge's fixed policy marker, never arbitrary stderr.
 * This is a bridge observation, not an authorization or filesystem boundary. */
export function instructionScopeObserver(emit: (scope: InstructionScope) => void): (chunk: string) => void {
  let pending = "";
  let overflow = false;
  return chunk => {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!overflow) {
        pending += part;
        if (pending.length > 2048) { pending = ""; overflow = true; }
      }
      if (!part.endsWith("\n")) continue;
      if (!overflow) {
        const base = { settings: "project", ancestors: "excluded", user: "excluded", local: "excluded", autoMemory: "excluded", auth: "official_profile" } as const;
        const v3 = V3.exec(pending);
        const v2 = v3 ? null : V2.exec(pending);
        if (v3) emit({ version: 3, ...base, exclusionCount: Number(v3[1]), hooks: "disabled", repositoryMcp: "excluded", accountConnectors: "excluded" });
        else if (v2) emit({ version: 2, ...base, exclusionCount: Number(v2[1]) });
      }
      pending = ""; overflow = false;
    }
  };
}
