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

/** CP2: the same, except an integration task's own session admits the account connectors (every call still meets the gate). */
interface InstructionScopeV4 extends Omit<InstructionScopeV3, "version" | "accountConnectors" | "settings"> {
  version: 4;
  settings: "project" | "none";
  accountConnectors: "excluded" | "integration";
}

type InstructionScope = InstructionScopeV2 | InstructionScopeV3 | InstructionScopeV4;

const V2 = /^\[konteks\] instruction_scope version=2 settings=project ancestors=excluded user=excluded local=excluded auto_memory=excluded auth=official_profile exclusions=(\d{1,4})\r?\n$/;
const V4 = /^\[konteks\] instruction_scope version=4 settings=(project|none) ancestors=excluded user=excluded local=excluded auto_memory=excluded auth=official_profile exclusions=(\d{1,4}) hooks=disabled repository_mcp=excluded account_connectors=(excluded|integration)\r?\n$/;
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
        const v4 = V4.exec(pending);
        const v3 = v4 ? null : V3.exec(pending);
        const v2 = v4 || v3 ? null : V2.exec(pending);
        // An integration session loads no setting sources at all (`settings=none`) and only it admits the account connectors.
        if (v4 && (v4[1] === "none") === (v4[3] === "integration")) emit({ version: 4, ...base, settings: v4[1] as "project" | "none", exclusionCount: Number(v4[2]), hooks: "disabled", repositoryMcp: "excluded", accountConnectors: v4[3] as "excluded" | "integration" });
        else if (v3) emit({ version: 3, ...base, exclusionCount: Number(v3[1]), hooks: "disabled", repositoryMcp: "excluded", accountConnectors: "excluded" });
        else if (v2) emit({ version: 2, ...base, exclusionCount: Number(v2[1]) });
      }
      pending = ""; overflow = false;
    }
  };
}
