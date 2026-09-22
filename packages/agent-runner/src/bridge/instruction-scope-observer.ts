interface InstructionScope {
  version: 2;
  settings: "project";
  ancestors: "excluded";
  user: "excluded";
  local: "excluded";
  autoMemory: "excluded";
  auth: "official_profile";
  exclusionCount: number;
}

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
        const match = /^\[konteks\] instruction_scope version=2 settings=project ancestors=excluded user=excluded local=excluded auto_memory=excluded auth=official_profile exclusions=(\d{1,4})\r?\n$/.exec(pending);
        if (match) emit({ version: 2, settings: "project", ancestors: "excluded", user: "excluded", local: "excluded", autoMemory: "excluded", auth: "official_profile", exclusionCount: Number(match[1]) });
      }
      pending = ""; overflow = false;
    }
  };
}
