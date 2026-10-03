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
      const scope = overflow ? null : decodeInstructionScope(pending);
      if (scope) emit(scope);
      pending = ""; overflow = false;
    }
  };
}

const SCOPE_BASE = { settings: "project", ancestors: "excluded", user: "excluded", local: "excluded", autoMemory: "excluded", auth: "official_profile" } as const;

/** One complete marker line, newest version first; null for anything else. */
function decodeInstructionScope(line: string): InstructionScope | null {
  const v4 = V4.exec(line);
  if (v4) return scopeV4(v4);
  const v3 = V3.exec(line);
  if (v3) return { version: 3, ...SCOPE_BASE, exclusionCount: Number(v3[1]), hooks: "disabled", repositoryMcp: "excluded", accountConnectors: "excluded" };
  const v2 = V2.exec(line);
  return v2 ? { version: 2, ...SCOPE_BASE, exclusionCount: Number(v2[1]) } : null;
}

/** An integration session loads no setting sources at all (`settings=none`) and only it admits the account connectors. */
function scopeV4(match: RegExpExecArray): InstructionScope | null {
  if ((match[1] === "none") !== (match[3] === "integration")) return null;
  return { version: 4, ...SCOPE_BASE, settings: match[1] as "project" | "none", exclusionCount: Number(match[2]), hooks: "disabled", repositoryMcp: "excluded", accountConnectors: match[3] as "excluded" | "integration" };
}
