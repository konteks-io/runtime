import { parse, type Expression, type Node, type Program, type SpreadElement } from "acorn";

/**
 * OpenCode 2's Code Mode gate (opencode-runtime-support CP4).
 *
 * OpenCode 2.0.18 reaches MCP tools ONLY through its `execute` tool, which
 * runs model-written JavaScript in OpenCode's own interpreter. It asks once
 * per block, then every call inside runs unasked, and the same catalogue
 * holds OpenCode's own tools (`opencode.session_move` changes the session's
 * working folder) that a deny rule cannot remove. So Konteks judges the code:
 * a block is approved only when a real JavaScript parser (acorn, the parser
 * family the interpreter uses) reads it as nothing but calls to this
 * session's own Konteks servers,
 *
 *     const result = await tools["konteks-platform"].platform__harness__plan_get({ planId: "p-1" });
 *     await tools["konteks-result"]["submit_result"]({ verdict: "pass" });
 *     return result;
 *
 * one call per statement, arguments written out as literals, and at most one
 * final `return` of what those calls produced. Anything else (another
 * namespace, a computed or string-built name, a loop, a variable in an
 * argument, `fetch`) is refused; a refusal is always safe and the agent
 * retries in the simple form. After the block ran, the calls OpenCode lists in
 * `rawOutput.metadata.toolCalls` are checked against what was approved
 * (`OpenCodeToolGovernance`).
 */

/**
 * Every MCP server name the connector gives a session (`konteks-platform`
 * from Core's capability, `konteks-preview`, `konteks-result`, and the QA
 * browser `konteks-browser`). A session's own subset is what it may call.
 */
export const KONTEKS_CODE_MODE_SERVERS: ReadonlySet<string> = new Set(["konteks-platform", "konteks-preview", "konteks-result", "konteks-browser"]);

/** One approved call: the Konteks server (Code Mode namespace) and its tool. */
export interface CodeModeCall { server: string; tool: string }

export type CodeModeBlock = { ok: true; calls: CodeModeCall[] } | { ok: false; reason: string };

/** The only form Konteks runs, as the agent is told it (prompt line and refusal log). */
export const CODE_MODE_ACCEPTED_FORM = "call Konteks tools only as `const result = await tools[\"<server>\"].<tool>({ ... });` with literal arguments, one call per statement, then `return result;`";

/** Code longer than this is never read (a legitimate block is a few calls). */
const MAX_CODE_LENGTH = 64 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
/** Names a block may bind, never one that shadows the interpreter's globals. */
const RESERVED = new Set(["tools", "fetch", "JSON", "Promise", "globalThis", "undefined", "NaN", "Infinity", "eval", "arguments"]);

class Refusal extends Error {}

function refuse(reason: string): never { throw new Refusal(reason); }

/**
 * Reads `code` and returns the Konteks calls it makes, or why it is not in
 * the accepted form. `servers` are the Code Mode namespaces this session may
 * call (its own MCP servers); any other namespace is refused.
 */
export function parseKonteksCodeModeBlock(code: string, servers: ReadonlySet<string>): CodeModeBlock {
  if (typeof code !== "string" || code.trim().length === 0) return { ok: false, reason: "the block is empty" };
  if (code.length > MAX_CODE_LENGTH) return { ok: false, reason: "the block is too long" };
  let program: Program;
  try {
    // A module: top-level `await` is native and HTML-style comments are not
    // comments, so nothing can hide behind a comment the interpreter would run.
    program = parse(code, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true, allowHashBang: false });
  } catch {
    return { ok: false, reason: "the block is not valid JavaScript" };
  }
  try {
    const calls: CodeModeCall[] = [];
    const bound = new Set<string>();
    program.body.forEach((statement, index) => {
      const last = index === program.body.length - 1;
      switch (statement.type) {
        case "VariableDeclaration": {
          if (statement.kind !== "const" && statement.kind !== "let") refuse("only `const` or `let` may hold a result");
          if (statement.declarations.length !== 1) refuse("declare one result per statement");
          const declaration = statement.declarations[0]!;
          if (declaration.id.type !== "Identifier") refuse("a result is held in a plain name");
          const name = declaration.id.name;
          if (RESERVED.has(name) || bound.has(name)) refuse(`the name ${name} cannot hold a result`);
          if (!declaration.init) refuse("a result must come from a Konteks tool call");
          calls.push(awaitedCall(declaration.init, servers));
          bound.add(name);
          return;
        }
        case "ExpressionStatement":
          calls.push(awaitedCall(statement.expression, servers));
          return;
        case "ReturnStatement":
          if (!last) refuse("`return` must be the last statement");
          if (statement.argument) returnValue(statement.argument, bound, servers, calls);
          return;
        default:
          refuse(`a ${statement.type} is not a Konteks tool call`);
      }
    });
    if (calls.length === 0) refuse("the block calls no Konteks tool");
    return { ok: true, calls };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}

/** `await tools["konteks-<server>"].<tool>(<literals>)` or `…["<tool>"](…)`. */
function awaitedCall(node: Expression, servers: ReadonlySet<string>): CodeModeCall {
  if (node.type !== "AwaitExpression") refuse("every Konteks tool call is awaited");
  const call = node.argument;
  if (call.type !== "CallExpression" || call.optional) refuse("only a Konteks tool call may be awaited");
  const callee = call.callee;
  if (callee.type !== "MemberExpression" || callee.optional) refuse("call a tool as tools[\"<server>\"].<tool>(…)");
  const namespace = callee.object;
  if (namespace.type !== "MemberExpression" || namespace.optional || !namespace.computed ||
      namespace.object.type !== "Identifier" || namespace.object.name !== "tools") {
    refuse("call a tool as tools[\"<server>\"].<tool>(…)");
  }
  const server = stringLiteral(namespace.property);
  if (server === null) refuse("the server is named with a plain string");
  if (!servers.has(server)) refuse(`${server} is not a Konteks server of this session`);
  const tool = callee.computed ? stringLiteral(callee.property) : callee.property.type === "Identifier" ? callee.property.name : null;
  if (tool === null || !TOOL_NAME.test(tool)) refuse("the tool is named with a plain name or string");
  for (const argument of call.arguments) literal(argument);
  return { server, tool };
}

function stringLiteral(node: Node): string | null {
  const value = node as { type: string; value?: unknown; regex?: unknown; bigint?: unknown };
  if (value.type === "Literal" && typeof value.value === "string") return value.value;
  const template = node as { type: string; expressions?: unknown[]; quasis?: Array<{ value: { cooked?: string | null } }> };
  if (template.type === "TemplateLiteral" && template.expressions?.length === 0 && template.quasis?.length === 1) {
    return template.quasis[0]!.value.cooked ?? null;
  }
  return null;
}

/** Arguments are data written out in full: no names, calls or spreads. */
function literal(node: Expression | SpreadElement | Node): void {
  const value = node as Node & Record<string, unknown>;
  switch (value.type) {
    case "Literal":
      if (value.regex !== undefined || value.bigint !== undefined) refuse("arguments are plain data");
      return;
    case "TemplateLiteral":
      if (stringLiteral(value) === null) refuse("arguments are plain data");
      return;
    case "UnaryExpression":
      if (value.operator !== "-" || (value.argument as { type: string; value?: unknown }).type !== "Literal" ||
          typeof (value.argument as { value?: unknown }).value !== "number") refuse("arguments are plain data");
      return;
    case "ArrayExpression":
      for (const element of value.elements as Array<Node | null>) {
        if (element === null) refuse("arguments are plain data");
        literal(element);
      }
      return;
    case "ObjectExpression":
      for (const property of value.properties as Node[]) {
        const entry = property as Node & { type: string; computed?: boolean; kind?: string; method?: boolean; shorthand?: boolean; key: Node; value: Node };
        if (entry.type !== "Property" || entry.computed || entry.kind !== "init" || entry.method || entry.shorthand) refuse("arguments are plain data");
        if (entry.key.type !== "Identifier" && stringLiteral(entry.key) === null &&
            !(entry.key.type === "Literal" && typeof (entry.key as { value?: unknown }).value === "number")) refuse("arguments are plain data");
        literal(entry.value);
      }
      return;
    default:
      refuse("arguments are plain data");
  }
}

/** What a block may return: its results, literal data, those in an object or array, or `JSON.stringify` of them. */
function returnValue(node: Expression | SpreadElement | Node, bound: ReadonlySet<string>, servers: ReadonlySet<string>, calls: CodeModeCall[]): void {
  const value = node as Node & Record<string, unknown>;
  switch (value.type) {
    case "Identifier":
      if (!bound.has(value.name as string)) refuse("return only what the block's calls produced");
      return;
    case "MemberExpression": {
      let object = value as Node & Record<string, unknown>;
      while (object.type === "MemberExpression") {
        if (object.computed || object.optional || (object.property as Node).type !== "Identifier") refuse("return only what the block's calls produced");
        object = object.object as Node & Record<string, unknown>;
      }
      if (object.type !== "Identifier" || !bound.has(object.name as string)) refuse("return only what the block's calls produced");
      return;
    }
    case "AwaitExpression":
      calls.push(awaitedCall(value as unknown as Expression, servers));
      return;
    case "ArrayExpression":
      for (const element of value.elements as Array<Node | null>) {
        if (element === null) refuse("return only what the block's calls produced");
        returnValue(element, bound, servers, calls);
      }
      return;
    case "ObjectExpression":
      for (const property of value.properties as Node[]) {
        const entry = property as Node & { type: string; computed?: boolean; kind?: string; method?: boolean; key: Node; value: Node };
        if (entry.type !== "Property" || entry.computed || entry.kind !== "init" || entry.method) refuse("return only what the block's calls produced");
        returnValue(entry.value, bound, servers, calls);
      }
      return;
    case "CallExpression": {
      const callee = value.callee as Node & Record<string, unknown>;
      const json = callee.type === "MemberExpression" && !callee.computed && !callee.optional && !value.optional &&
        (callee.object as Node & { name?: string }).type === "Identifier" && (callee.object as { name?: string }).name === "JSON" &&
        (callee.property as { name?: string }).name === "stringify";
      const args = value.arguments as Node[];
      if (!json || args.length === 0 || args.length > 3) refuse("return only what the block's calls produced");
      returnValue(args[0]!, bound, servers, calls);
      for (const extra of args.slice(1)) literal(extra);
      return;
    }
    default:
      literal(value);
  }
}
