// A scripted model for the agent OS proof: one loopback server speaking the
// three wire protocols the connector's agents use, so every agent's REAL
// tool calls and permission requests can be driven without a provider or a
// credential.
//   POST …/chat/completions  OpenAI chat completions (OpenCode, a config provider)
//   POST …/messages          Anthropic Messages (Claude Code via ANTHROPIC_BASE_URL,
//                            DeepSeek Harness via DEEPSEEK_BASE_URL)
//   POST …/responses         OpenAI Responses (Codex, a config model provider)
// Each prompt carries a step marker (`KONTEKS-PROBE STEP <id>`); the first
// model call of that step answers with the step's tool call, built from the
// tool list and JSON schema the agent itself sent, and every later call of
// the step (after the tool result, or a model call without tools such as a
// title) answers with plain text. Tool results are kept per step, so the
// probe can read what a command printed.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

export const STEP_MARKER = "KONTEKS-PROBE STEP";
const MARKER = /KONTEKS-PROBE STEP ([A-Za-z0-9_-]+)/g;

/**
 * @param {{ intents: Map<string, object>, log?: (line: string) => void, windows?: boolean }} options
 *   intents: step id → { type: "shell", command, pwshCommand?, escalate? } | { type: "write", path, content }
 *   | { type: "mcp", server, tool, args } | { type: "text" }
 */
export async function startScriptedModels(options) {
  const log = options.log ?? (() => {});
  const served = new Map(); // step → number of tool calls served
  const toolResults = new Map(); // step → [text]
  const calls = [];
  let dumped = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      try { handle(req, res, raw); } catch (error) {
        log(`scripted model error on ${req.method} ${req.url}: ${error.stack ?? error}`);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "api_error", message: String(error.message ?? error) } }));
      }
    });
  });

  function handle(req, res, raw) {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && /\/models$/.test(path)) return json(res, modelsList(path));
    if (req.method === "HEAD" || req.method === "GET") return json(res, {});
    const body = raw ? JSON.parse(raw) : {};
    if (process.env.KONTEKS_PROOF_DUMP_DIR) writeFileSync(join(process.env.KONTEKS_PROOF_DUMP_DIR, `${String(++dumped).padStart(3, "0")}-${path.split("/").pop()}.json`), JSON.stringify(body, null, 2));
    if (/\/messages\/count_tokens$/.test(path)) return json(res, { input_tokens: 12 });
    if (/\/chat\/completions$/.test(path)) return chatCompletions(res, body);
    if (/\/messages$/.test(path)) return anthropicMessages(res, body);
    if (/\/responses$/.test(path)) return responses(res, body);
    log(`scripted model: unknown ${req.method} ${path}`);
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not found" } }));
  }

  function modelsList(path) {
    const data = [{ id: "konteks-probe", object: "model", type: "model", display_name: "Konteks probe", created_at: "2026-01-01T00:00:00Z", owned_by: "konteks" }];
    return /anthropic|\/v1\/models$/.test(path) ? { data, has_more: false, first_id: "konteks-probe", last_id: "konteks-probe", object: "list" } : { object: "list", data };
  }

  /** The step of this conversation: the LAST marker in any user text. */
  function stepOf(texts) {
    let step = null;
    for (const text of texts) for (const match of String(text).matchAll(MARKER)) step = match[1];
    return step;
  }

  /** Decide the answer: a tool call for the first call of a step with tools, text otherwise. */
  /** Every tool call this model issued, by call id → its step; each result is recorded once, wherever it appears in the history. */
  const issued = new Map();
  const recorded = new Set();
  function record(id, text) {
    const step = issued.get(id);
    if (step === undefined || recorded.has(id)) return;
    recorded.add(id);
    toolResults.set(step, [...(toolResults.get(step) ?? []), text]);
  }
  function harvest(protocol, body) {
    if (protocol === "chat") for (const message of body.messages ?? []) { if (message?.role === "tool") record(message.tool_call_id, textOf(message.content)); }
    if (protocol === "anthropic") for (const message of body.messages ?? []) for (const block of Array.isArray(message?.content) ? message.content : []) { if (block?.type === "tool_result") record(block.tool_use_id, textOf(block.content)); }
    if (protocol === "responses") for (const item of body.input ?? []) { if (typeof item?.type === "string" && item.type.endsWith("_output")) record(item.call_id, typeof item.output === "string" ? item.output : textOf(item.output?.content ?? item.output)); }
  }

  function decide(protocol, step, tools, afterTool) {
    const intent = step ? options.intents.get(step) : undefined;
    calls.push({ protocol, step, tools: tools.map(tool => tool.name), afterTool });
    if (!intent || intent.type === "text" || afterTool || tools.length === 0 || (served.get(step) ?? 0) > 0) return { text: `DONE ${step ?? ""}`.trim() };
    const call = toolCall(intent, tools, options.windows === true);
    if (!call) { log(`scripted model: step ${step} found no tool for ${intent.type} among ${tools.map(tool => tool.name).join(",")}`); return { text: `NO TOOL ${step}` }; }
    served.set(step, 1);
    call.id = `${protocol === "anthropic" ? "toolu" : "call"}_konteks_${callId()}`;
    issued.set(call.id, step);
    log(`scripted model (${protocol}) step ${step}: ${call.name}(${JSON.stringify(call.input).slice(0, 240)})`);
    return { call };
  }

  // ── OpenAI chat completions ───────────────────────────────────────────────
  function chatCompletions(res, body) {
    harvest("chat", body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const texts = messages.filter(message => message.role === "user").map(message => textOf(message.content));
    const last = messages.at(-1);
    const tools = (body.tools ?? []).map(tool => ({ name: tool.function?.name, schema: tool.function?.parameters, kind: "function" })).filter(tool => tool.name);
    const answer = decide("chat", stepOf(texts), tools, last?.role === "tool");
    const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ id: "konteks-probe", object: "chat.completion.chunk", created: 0, model: body.model ?? "konteks-probe", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const usage = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    if (body.stream === false) {
      const message = answer.call
        ? { role: "assistant", content: null, tool_calls: [{ id: answer.call.id, type: "function", function: { name: answer.call.name, arguments: JSON.stringify(answer.call.input) } }] }
        : { role: "assistant", content: answer.text };
      return json(res, { id: "konteks-probe", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, message, finish_reason: answer.call ? "tool_calls" : "stop" }], ...usage });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (answer.call) {
      res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: answer.call.id, type: "function", function: { name: answer.call.name, arguments: JSON.stringify(answer.call.input) } }] }));
      res.write(chunk({}, "tool_calls", usage));
    } else {
      res.write(chunk({ role: "assistant", content: answer.text }));
      res.write(chunk({}, "stop", usage));
    }
    res.end("data: [DONE]\n\n");
  }

  // ── Anthropic Messages ────────────────────────────────────────────────────
  function anthropicMessages(res, body) {
    harvest("anthropic", body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const texts = messages.filter(message => message.role === "user").map(message => textOf(message.content, block => block.type === "text"));
    const last = messages.at(-1);
    const results = Array.isArray(last?.content) ? last.content.filter(block => block?.type === "tool_result") : [];
    const afterTool = last?.role === "user" && results.length > 0;
    const tools = (body.tools ?? []).filter(tool => tool?.name && tool.input_schema).map(tool => ({ name: tool.name, schema: tool.input_schema, kind: "function" }));
    const answer = decide("anthropic", stepOf(texts), tools, afterTool, afterTool ? results.map(block => textOf(block.content)).join("\n") : undefined);
    const id = `msg_${callId()}`;
    const model = body.model ?? "konteks-probe";
    const content = answer.call ? [{ type: "tool_use", id: answer.call.id, name: answer.call.name, input: answer.call.input }] : [{ type: "text", text: answer.text }];
    const stopReason = answer.call ? "tool_use" : "end_turn";
    if (body.stream !== true) {
      return json(res, { id, type: "message", role: "assistant", model, content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
    event("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    const block = content[0];
    if (block.type === "tool_use") {
      event("content_block_start", { index: 0, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else {
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
    }
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
    event("message_stop", {});
    res.end();
  }

  // ── OpenAI Responses ──────────────────────────────────────────────────────
  function responses(res, body) {
    harvest("responses", body);
    const input = Array.isArray(body.input) ? body.input : [];
    const texts = input.filter(item => item?.role === "user").map(item => textOf(item.content));
    const last = input.at(-1);
    const describe = tool => tool?.type === "function" ? { name: tool.name, schema: tool.parameters, kind: "function", ...(tool.namespace ? { namespace: tool.namespace } : {}) }
      : tool?.type === "custom" ? { name: tool.name, kind: "custom" }
        : tool?.type === "local_shell" ? { name: "local_shell", kind: "local_shell" }
          : tool?.type === "tool_search" ? { name: "tool_search", kind: "tool_search" }
            : tool?.type === "namespace" && Array.isArray(tool.tools) ? tool.tools.map(inner => describe({ ...inner, namespace: tool.name })) : null;
    // Codex defers MCP tools behind `tool_search` (executed by the client):
    // the tools a search returned count as offered from then on.
    const searched = input.filter(item => item?.type === "tool_search_output").flatMap(item => item.tools ?? []);
    const tools = [...(body.tools ?? []), ...searched].map(describe).flat().filter(tool => tool && tool.name);
    const step = stepOf(texts);
    const intent = step ? options.intents.get(step) : undefined;
    const searchedLast = last?.type === "tool_search_output";
    if (intent?.type === "mcp" && !searchedLast && (served.get(step) ?? 0) === 0 && !toolCall(intent, tools.filter(tool => tool.kind !== "tool_search" && tool.name !== "execute"), false)
        && tools.some(tool => tool.kind === "tool_search")) {
      log(`scripted model (responses) step ${step}: tool_search(${intent.tool})`);
      return streamResponse(res, body, { type: "tool_search_call", id: `tsc_${callId()}`, call_id: `call_${callId()}`, status: "completed", execution: "client", arguments: { query: `${intent.server} ${intent.tool}`, limit: 8 } });
    }
    const afterTool = typeof last?.type === "string" && last.type.endsWith("_output") && !searchedLast;
    const outputText = afterTool ? (typeof last.output === "string" ? last.output : textOf(last.output?.content ?? last.output)) : undefined;
    const answer = decide("responses", step, tools.filter(tool => tool.kind !== "tool_search"), afterTool, outputText);
    let item;
    if (answer.call?.kind === "custom") item = { type: "custom_tool_call", id: `ctc_${callId()}`, call_id: answer.call.id, name: answer.call.name, input: answer.call.input, status: "completed" };
    else if (answer.call?.kind === "local_shell") item = { type: "local_shell_call", id: `lsh_${callId()}`, call_id: answer.call.id, status: "completed", action: { type: "exec", command: answer.call.input.command, env: {} } };
    else if (answer.call) item = { type: "function_call", id: `fc_${callId()}`, call_id: answer.call.id, name: answer.call.name, ...(answer.call.namespace ? { namespace: answer.call.namespace } : {}), arguments: JSON.stringify(answer.call.input), status: "completed" };
    else item = { type: "message", id: `msg_${callId()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: answer.text, annotations: [] }] };
    return streamResponse(res, body, item);
  }

  function streamResponse(res, body, item) {
    const id = `resp_${callId()}`;
    const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };
    const response = { id, object: "response", created_at: 0, status: "completed", model: body.model ?? "konteks-probe", output: [item], usage };
    if (body.stream === false) return json(res, response);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let sequence = 0;
    const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, sequence_number: sequence++, ...data })}\n\n`);
    event("response.created", { response: { ...response, status: "in_progress", output: [] } });
    event("response.output_item.added", { output_index: 0, item: item.type === "message" ? { ...item, status: "in_progress", content: [] } : item });
    if (item.type === "message") event("response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text });
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response });
    res.end();
  }

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    calls,
    toolResults,
    served: step => served.get(step) ?? 0,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function json(res, value) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
let counter = 0;
function callId() { counter += 1; return `${Date.now().toString(36)}${counter}`; }
function textOf(content, keep = () => true) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(block => block && keep(block)).map(block => typeof block === "string" ? block : block.text ?? (typeof block.content === "string" ? block.content : textOf(block.content ?? ""))).join("\n");
  if (content && typeof content === "object") return content.text ?? JSON.stringify(content);
  return "";
}

// ── tool selection from the agent's own tool list ───────────────────────────
const SHELL_TOOLS = ["bash", "shell", "shell_command", "exec_command", "pwsh", "powershell", "local_shell"];
const WRITE_TOOLS = ["write", "str_replace_editor", "apply_patch", "create_file"];
const lower = value => String(value ?? "").toLowerCase();

/** The concrete call for an intent, from the tools and schemas this agent sent. */
export function toolCall(intent, tools, windows) {
  const byName = names => names.map(name => tools.find(tool => lower(tool.name) === name)).find(Boolean);
  if (intent.type === "shell") {
    const tool = byName(SHELL_TOOLS);
    if (!tool) return null;
    const powershell = /pwsh|powershell/.test(lower(tool.name)) || (windows && intent.pwshCommand !== undefined && /^(shell|shell_command|exec_command)$/.test(lower(tool.name)));
    const command = powershell && intent.pwshCommand !== undefined ? intent.pwshCommand : intent.command;
    if (tool.kind === "local_shell") return { name: tool.name, kind: "local_shell", input: { command: windows ? ["powershell.exe", "-NoProfile", "-Command", command] : ["bash", "-lc", command] } };
    return { name: tool.name, kind: tool.kind, input: fill(tool.schema, {
      command: prop => prop?.type === "array" ? (windows ? ["powershell.exe", "-NoProfile", "-Command", command] : ["bash", "-lc", command]) : command,
      cmd: () => command,
      description: () => "Konteks OS proof step",
      // Escalation (Codex, dsh): ask for the command outside the agent's own sandbox, so the request reaches Konteks.
      ...(intent.escalate ? { sandbox_permissions: () => "require_escalated", with_escalated_permissions: () => true, justification: () => "The Konteks OS proof asks for this on purpose." } : {}),
    }) };
  }
  if (intent.type === "write") {
    const tool = byName(WRITE_TOOLS);
    if (!tool) return null;
    if (lower(tool.name) === "apply_patch") {
      const patch = `*** Begin Patch\n*** Add File: ${intent.path}\n+${intent.content}\n*** End Patch\n`;
      return tool.kind === "custom" ? { name: tool.name, kind: "custom", input: patch } : { name: tool.name, kind: tool.kind, input: fill(tool.schema, { input: () => patch, patch: () => patch }) };
    }
    return { name: tool.name, kind: tool.kind, input: fill(tool.schema, {
      command: prop => Array.isArray(prop?.enum) && prop.enum.includes("create") ? "create" : undefined,
      file_path: () => intent.path, filePath: () => intent.path, path: () => intent.path, target_file: () => intent.path,
      content: () => intent.content, file_text: () => intent.content, text: () => intent.content, contents: () => intent.content,
    }) };
  }
  if (intent.type === "mcp") {
    const direct = tools.find(tool => lower(tool.name).includes(lower(intent.tool)) && lower(tool.name).includes(lower(intent.server).replace(/-/g, "")) )
      ?? tools.find(tool => lower(tool.name).includes(lower(intent.tool)) && lower(tool.name).includes(lower(intent.server)))
      ?? tools.find(tool => lower(tool.name).endsWith(lower(intent.tool)));
    if (direct) return { name: direct.name, kind: direct.kind, ...(direct.namespace ? { namespace: direct.namespace } : {}), input: direct.kind === "custom" ? JSON.stringify(intent.args) : intent.args };
    // OpenCode 2 reaches MCP tools only through Code Mode's `execute`.
    const execute = byName(["execute"]);
    if (!execute) return null;
    const code = `return await tools[${JSON.stringify(intent.server)}].${intent.tool}(${JSON.stringify(intent.args)});`;
    return { name: execute.name, kind: execute.kind, input: fill(execute.schema, { code: () => code, description: () => "Konteks OS proof step" }) };
  }
  return null;
}

/** Arguments for a JSON schema: the provided keys, then any other required key with a harmless value. */
function fill(schema, provided) {
  const properties = schema?.properties ?? {};
  const input = {};
  for (const [key, make] of Object.entries(provided)) {
    if (!(key in properties)) continue;
    const value = make(properties[key]);
    if (value !== undefined) input[key] = value;
  }
  for (const key of schema?.required ?? []) {
    if (key in input) continue;
    const prop = properties[key] ?? {};
    input[key] = Array.isArray(prop.enum) ? prop.enum[0]
      : prop.type === "number" || prop.type === "integer" ? 120000
        : prop.type === "boolean" ? false
          : prop.type === "array" ? [] : prop.type === "object" ? {} : "Konteks OS proof step";
  }
  return input;
}
