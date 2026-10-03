import {
  parse,
  type Expression, type MemberExpression, type ModuleDeclaration, type Node, type Program, type ReturnStatement,
  type SpreadElement, type Statement, type Super, type VariableDeclaration,
} from "acorn";

/**
 * OpenCode 2's Code Mode gate.
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

type CodeModeBlock = { ok: true; calls: CodeModeCall[] } | { ok: false; reason: string };

/** The only form Konteks runs, as the agent is told it (prompt line and refusal log). */
export const CODE_MODE_ACCEPTED_FORM = "call Konteks tools only as `const result = await tools[\"<server>\"].<tool>({ ... });` with literal arguments, one call per statement, then `return result;`";

/** Code longer than this is never read (a legitimate block is a few calls). */
const MAX_CODE_LENGTH = 64 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
/** Names a block may bind, never one that shadows the interpreter's globals. */
const RESERVED = new Set(["tools", "fetch", "JSON", "Promise", "globalThis", "undefined", "NaN", "Infinity", "eval", "arguments"]);

class Refusal extends Error {}

function refuse(reason: string): never { throw new Refusal(reason); }

const PLAIN_DATA = "arguments are plain data";
const OWN_RESULTS = "return only what the block's calls produced";
const TOOL_CALL_FORM = "call a tool as tools[\"<server>\"].<tool>(…)";

type AnyNode = Node & Record<string, unknown>;
type PropertyNode = Node & { type: string; computed?: boolean; kind?: string; method?: boolean; shorthand?: boolean; key: Node; value: Node };

/**
 * Reads `code` and returns the Konteks calls it makes, or why it is not in
 * the accepted form. `servers` are the Code Mode namespaces this session may
 * call (its own MCP servers); any other namespace is refused.
 */
export function parseKonteksCodeModeBlock(code: string, servers: ReadonlySet<string>): CodeModeBlock {
  if (typeof code !== "string" || code.trim().length === 0) return { ok: false, reason: "the block is empty" };
  if (code.length > MAX_CODE_LENGTH) return { ok: false, reason: "the block is too long" };
  const program = parsedModule(code);
  if (program === null) return { ok: false, reason: "the block is not valid JavaScript" };
  try {
    const reader = new BlockReader(servers);
    program.body.forEach((statement, index) => reader.statement(statement, index === program.body.length - 1));
    if (reader.calls.length === 0) refuse("the block calls no Konteks tool");
    return { ok: true, calls: reader.calls };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}

function parsedModule(code: string): Program | null {
  try {
    // A module: top-level `await` is native and HTML-style comments are not
    // comments, so nothing can hide behind a comment the interpreter would run.
    return parse(code, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true, allowHashBang: false });
  } catch {
    return null;
  }
}

/** Reads a block statement by statement: the calls it makes and the names that hold their results. */
class BlockReader {
  readonly calls: CodeModeCall[] = [];
  private readonly bound = new Set<string>();

  constructor(private readonly servers: ReadonlySet<string>) {}

  statement(statement: Statement | ModuleDeclaration, last: boolean): void {
    switch (statement.type) {
      case "VariableDeclaration":
        return this.declaration(statement);
      case "ExpressionStatement":
        this.calls.push(awaitedCall(statement.expression, this.servers));
        return;
      case "ReturnStatement":
        return this.returnStatement(statement, last);
      default:
        refuse(`a ${statement.type} is not a Konteks tool call`);
    }
  }

  private declaration(statement: VariableDeclaration): void {
    if (statement.kind !== "const" && statement.kind !== "let") refuse("only `const` or `let` may hold a result");
    if (statement.declarations.length !== 1) refuse("declare one result per statement");
    const declaration = statement.declarations[0]!;
    if (declaration.id.type !== "Identifier") refuse("a result is held in a plain name");
    const name = declaration.id.name;
    if (RESERVED.has(name) || this.bound.has(name)) refuse(`the name ${name} cannot hold a result`);
    if (!declaration.init) refuse("a result must come from a Konteks tool call");
    this.calls.push(awaitedCall(declaration.init, this.servers));
    this.bound.add(name);
  }

  private returnStatement(statement: ReturnStatement, last: boolean): void {
    if (!last) refuse("`return` must be the last statement");
    if (statement.argument) this.returnValue(statement.argument);
  }

  /** What a block may return: its results, literal data, those in an object or array, or `JSON.stringify` of them. */
  private returnValue(node: Expression | SpreadElement | Node): void {
    const value = node as AnyNode;
    switch (value.type) {
      case "Identifier":
        if (!this.bound.has(value.name as string)) refuse(OWN_RESULTS);
        return;
      case "MemberExpression":
        return this.boundMember(value);
      case "AwaitExpression":
        this.calls.push(awaitedCall(value as unknown as Expression, this.servers));
        return;
      case "ArrayExpression":
        return this.returnedElements(value.elements as Array<Node | null>);
      case "ObjectExpression":
        return this.returnedProperties(value.properties as Node[]);
      case "CallExpression":
        return this.returnedJson(value);
      default:
        literal(value);
    }
  }

  private boundMember(value: AnyNode): void {
    let object = value;
    while (object.type === "MemberExpression") {
      if (object.computed || object.optional || (object.property as Node).type !== "Identifier") refuse(OWN_RESULTS);
      object = object.object as AnyNode;
    }
    if (object.type !== "Identifier" || !this.bound.has(object.name as string)) refuse(OWN_RESULTS);
  }

  private returnedElements(elements: Array<Node | null>): void {
    for (const element of elements) {
      if (element === null) refuse(OWN_RESULTS);
      this.returnValue(element);
    }
  }

  private returnedProperties(properties: Node[]): void {
    for (const property of properties) {
      const entry = property as PropertyNode;
      if (!initProperty(entry)) refuse(OWN_RESULTS);
      this.returnValue(entry.value);
    }
  }

  private returnedJson(value: AnyNode): void {
    const args = value.arguments as Node[];
    if (!jsonStringify(value) || args.length === 0 || args.length > 3) refuse(OWN_RESULTS);
    this.returnValue(args[0]!);
    for (const extra of args.slice(1)) literal(extra);
  }
}

/** `JSON.stringify(…)`, called plainly. */
function jsonStringify(value: AnyNode): boolean {
  const callee = value.callee as AnyNode;
  return callee.type === "MemberExpression" && !callee.computed && !callee.optional && !value.optional &&
    (callee.object as Node & { name?: string }).type === "Identifier" && (callee.object as { name?: string }).name === "JSON" &&
    (callee.property as { name?: string }).name === "stringify";
}

/** `await tools["konteks-<server>"].<tool>(<literals>)` or `…["<tool>"](…)`. */
function awaitedCall(node: Expression, servers: ReadonlySet<string>): CodeModeCall {
  if (node.type !== "AwaitExpression") refuse("every Konteks tool call is awaited");
  const call = node.argument;
  if (call.type !== "CallExpression" || call.optional) refuse("only a Konteks tool call may be awaited");
  const callee = call.callee;
  if (callee.type !== "MemberExpression" || callee.optional) refuse(TOOL_CALL_FORM);
  const server = calledServer(callee.object, servers);
  const tool = calledTool(callee);
  for (const argument of call.arguments) literal(argument);
  return { server, tool };
}

/** The server in `tools["<server>"]`: a plain string naming one of this session's servers. */
function calledServer(namespace: Expression | Super, servers: ReadonlySet<string>): string {
  if (namespace.type !== "MemberExpression" || namespace.optional || !namespace.computed ||
      namespace.object.type !== "Identifier" || namespace.object.name !== "tools") {
    refuse(TOOL_CALL_FORM);
  }
  const server = stringLiteral(namespace.property);
  if (server === null) refuse("the server is named with a plain string");
  if (!servers.has(server)) refuse(`${server} is not a Konteks server of this session`);
  return server;
}

function calledTool(callee: MemberExpression): string {
  const tool = callee.computed ? stringLiteral(callee.property) : callee.property.type === "Identifier" ? callee.property.name : null;
  if (tool === null || !TOOL_NAME.test(tool)) refuse("the tool is named with a plain name or string");
  return tool;
}

function stringLiteral(node: Node): string | null {
  const value = node as { type: string; value?: unknown; regex?: unknown; bigint?: unknown };
  if (value.type === "Literal" && typeof value.value === "string") return value.value;
  return templateString(node);
}

/** A template literal with no substitutions, by its cooked text. */
function templateString(node: Node): string | null {
  const template = node as { type: string; expressions?: unknown[]; quasis?: Array<{ value: { cooked?: string | null } }> };
  if (template.type !== "TemplateLiteral" || template.expressions?.length !== 0 || template.quasis?.length !== 1) return null;
  return template.quasis[0]!.value.cooked ?? null;
}

/** An object property written as `key: value` (no computed key, getter, setter or method). */
function initProperty(entry: PropertyNode): boolean {
  return entry.type === "Property" && !entry.computed && entry.kind === "init" && !entry.method;
}

/** A property key written out: a name, a plain string or a number. */
function plainKey(key: Node): boolean {
  return key.type === "Identifier" || stringLiteral(key) !== null || (key.type === "Literal" && typeof (key as { value?: unknown }).value === "number");
}

/** Arguments are data written out in full: no names, calls or spreads. */
function literal(node: Expression | SpreadElement | Node): void {
  const value = node as AnyNode;
  const check = LITERAL_CHECKS.get(value.type);
  if (check === undefined) refuse(PLAIN_DATA);
  check(value);
}

function negativeNumber(value: AnyNode): void {
  const argument = value.argument as { type: string; value?: unknown };
  if (value.operator !== "-" || argument.type !== "Literal" || typeof argument.value !== "number") refuse(PLAIN_DATA);
}

function literalElements(value: AnyNode): void {
  for (const element of value.elements as Array<Node | null>) {
    if (element === null) refuse(PLAIN_DATA);
    literal(element);
  }
}

function literalProperties(value: AnyNode): void {
  for (const property of value.properties as Node[]) {
    const entry = property as PropertyNode;
    if (!initProperty(entry) || entry.shorthand) refuse(PLAIN_DATA);
    if (!plainKey(entry.key)) refuse(PLAIN_DATA);
    literal(entry.value);
  }
}

const LITERAL_CHECKS: ReadonlyMap<string, (value: AnyNode) => void> = new Map<string, (value: AnyNode) => void>([
  ["Literal", value => { if (value.regex !== undefined || value.bigint !== undefined) refuse(PLAIN_DATA); }],
  ["TemplateLiteral", value => { if (stringLiteral(value) === null) refuse(PLAIN_DATA); }],
  ["UnaryExpression", negativeNumber],
  ["ArrayExpression", literalElements],
  ["ObjectExpression", literalProperties],
]);
