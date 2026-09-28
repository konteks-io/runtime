import { extractStructuredOutputCandidate, readStructuredOutputContract, STRUCTURED_RESULT_TOOL_NAME } from "@konteks/agent-core";
import type { ValidateFunction } from "ajv";
import type { ResultToolDefinition } from "./result-tool-server.js";

/**
 * A prompt that asks for a structured result, and the prompt the agent sees.
 *
 * The cloud caller ends its prompt with the structured-output contract block
 * (`renderStructuredOutputContract` in agent-core): the heading, the fence
 * instruction and the JSON Schema. The connector lifts the schema into the
 * `submit_result` tool and replaces the block with one line, so neither the
 * schema dump nor a JSON block lands in the person's own agent history. When
 * the agent could not be shown the schema in the tool definition (it did not
 * re-read its tools), the line carries the schema instead; the tool still
 * validates and corrects.
 */
export const RESULT_TOOL_LINE = `When you are finished, call \`${STRUCTURED_RESULT_TOOL_NAME}\` once with your result.`;

/** The one follow-up prompt, sent when the turn ended with neither a valid call nor a valid fenced result. */
export const RESULT_FOLLOW_UP = `You did not call \`${STRUCTURED_RESULT_TOOL_NAME}\` with a valid result. Call it now, once, with your whole result.`;

export function resultToolLineWithSchema(schema: Record<string, unknown>, wrapped: boolean): string {
  const where = wrapped ? "with your whole result in its `result` argument" : "with your whole result as its arguments (one JSON object)";
  return [
    `When you are finished, call the \`${STRUCTURED_RESULT_TOOL_NAME}\` tool once ${where}. The result must validate against this JSON Schema; if the tool answers with problems, fix exactly those and call it again.`,
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}

export interface StructuredContract {
  schema: Record<string, unknown>;
  /** Index of the prompt block that carries the contract (always the last one). */
  index: number;
  /** That block's text before the contract. */
  before: string;
}

/** The contract at the end of the prompt's last block, if the prompt carries one. */
/** The part of an ACP content block this needs; the relay and the bridge each have their own full type. */
export interface PromptBlock { type: string }

export function findStructuredContract(prompt: readonly PromptBlock[]): StructuredContract | null {
  const index = prompt.length - 1;
  const last = prompt[index] as { type: string; text?: unknown } | undefined;
  if (!last || last.type !== "text" || typeof last.text !== "string") return null;
  const read = readStructuredOutputContract(last.text);
  return read ? { schema: read.schema, index, before: read.before } : null;
}

/** The prompt the agent receives: the contract block replaced by the tool line. */
export function rewriteStructuredPrompt<B extends PromptBlock>(prompt: readonly B[], contract: StructuredContract, line: string): B[] {
  const text = contract.before ? `${contract.before}\n\n${line}` : line;
  return prompt.map((block, index) => (index === contract.index ? ({ type: "text", text } as unknown as B) : block));
}

/** A fenced (or bare) JSON result in the agent's text that validates, else null. */
export function parseFencedResult(text: string, validate: ValidateFunction): { value: unknown } | null {
  const candidate = extractStructuredOutputCandidate(text);
  if (candidate === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  return validate(value) ? { value } : null;
}

type Usage = Record<string, unknown> | null | undefined;
const USAGE_FIELDS = ["totalTokens", "inputTokens", "outputTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens"] as const;

/** The turn's usage including its follow-up: every field both sides report is summed. */
export function sumPromptUsage(first: Usage, second: Usage): Usage {
  if (!first) return second;
  if (!second) return first;
  const sum: Record<string, unknown> = { ...first };
  for (const field of USAGE_FIELDS) {
    const a = first[field];
    const b = second[field];
    if (typeof a === "number" && typeof b === "number") sum[field] = a + b;
  }
  return sum;
}

/** What the session keeps for a turn that asked for a result. */
export interface StructuredTurnState {
  requestId: string;
  validate: ValidateFunction;
  definition: ResultToolDefinition;
  /** The agent's message text this turn (bounded), for the fenced fallback. */
  text: string;
  followUp: { requestId: string; original: Record<string, unknown> } | null;
}

/** Enough of the agent's text for any result the frame could carry. */
export const MAX_STRUCTURED_TURN_TEXT = 1024 * 1024;

export function followUpRequestId(requestId: string): string {
  return `${requestId}#konteks-result-follow-up`;
}
