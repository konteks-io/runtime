import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { HostPromptTurn } from "./host-agent.js";

interface TurnState {
  turn: HostPromptTurn;
  taken: boolean;
  admitted?: Promise<void>;
}

const refused = () => new Error("OpenCode managed Skill load admission was refused");

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw refused();
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function matches(value: unknown, turn: HostPromptTurn): value is { digests?: unknown } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return input.acpSessionRef === turn.acpSessionRef && input.bridgeSessionId === turn.bridgeSessionId && input.requestId === turn.requestId;
}

/** Host-retained content and turn authority; the plugin's private files never grant permission. */
export function openCodeTurnAdmission(roots: readonly string[], content: readonly string[]) {
  const digests = content.map(text => createHash("sha256").update(text).digest("hex"));
  const verifyDigests = (actual: unknown) => {
    if (!Array.isArray(actual) || actual.length !== digests.length || digests.some((digest, index) => actual[index] !== digest)) throw refused();
  };
  const verifiedRoots = Object.freeze([...roots]);
  let current: TurnState | undefined;
  const assertCurrent = (state: TurnState) => { if (current !== state) throw refused(); };
  const authorize = async (state: TurnState) => {
    if (!state.turn.admitSkillLoad) throw refused();
    await state.turn.admitSkillLoad(verifiedRoots);
    assertCurrent(state);
  };
  return {
    prepare(turn?: HostPromptTurn) { current = turn ? { turn: Object.freeze({ ...turn }), taken: false } : undefined; },
    finish(turn: HostPromptTurn) {
      if (current?.turn.acpSessionRef === turn.acpSessionRef && current.turn.requestId === turn.requestId) current = undefined;
    },
    clear() { current = undefined; },
    take() {
      if (!current || current.taken) throw refused();
      current.taken = true;
      return current.turn;
    },
    async handle(request: IncomingMessage) {
      const value = await body(request);
      const state = current;
      if (!state?.taken || !matches(value, state.turn)) throw refused();
      if (request.url === "/load") {
        verifyDigests(value.digests);
        state.admitted ??= authorize(state);
      }
      if (!state.admitted) throw refused();
      await state.admitted;
      assertCurrent(state);
    },
  };
}
