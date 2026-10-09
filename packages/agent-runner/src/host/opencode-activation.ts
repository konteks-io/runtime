import type { HostPromptTurn } from "./host-agent.js";
import { openCodeSkillContent } from "./opencode-skill-content.js";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";

const source = `import { readFile } from "node:fs/promises";
export default {
  id: "konteks-managed-skills-activation",
  async setup(context) {
    const { endpoint, token } = context.options;
    const expectedContent = JSON.parse(await readFile(new URL("./skills.json", import.meta.url), "utf8"));
    const send = async action => {
      const response = await fetch(endpoint.replace(/ready$/, action), {
        method: "POST", headers: { authorization: "Bearer " + token },
        redirect: "error", signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error("Konteks plugin activation was refused");
      if (action === "turn") return response.json();
      await response.body?.cancel();
    };
    const registrations = [];
    let selectedMessage;
    const nativeID = value => typeof value === "string" && value.length > 0 && value.length <= 256;
    const select = async input => {
      selectedMessage = undefined;
      if (!nativeID(input.sessionID) || !nativeID(input.messageID)) throw new Error("OpenCode native Skill prompt identity is unavailable");
      const turn = await send("turn");
      if (turn.bridgeSessionId !== input.sessionID) throw new Error("OpenCode native Skill prompt does not match the governed turn");
      const result = await context.skill.list();
      if (!Array.isArray(result.data)) throw new Error("OpenCode Skill inventory is unavailable");
      const selected = context.options.skillFiles.map(path => {
        const matches = result.data.filter(skill => skill.path === path);
        if (matches.length !== 1 || typeof matches[0].id !== "string" || !matches[0].id) {
          throw new Error("Required OpenCode Skill inventory is missing or ambiguous");
        }
        return { id: matches[0].id };
      });
      const ids = new Set(selected.map(skill => skill.id));
      if (ids.size !== selected.length) throw new Error("Required OpenCode Skill inventory is ambiguous");
      if ((input.prompt.skills ?? []).some(skill => !ids.has(skill.id))) {
        throw new Error("OpenCode requested an unauthorized Skill attachment");
      }
      input.prompt.skills = selected;
      selectedMessage = { sessionID: input.sessionID, messageID: input.messageID };
    };
    const deny = async () => { throw new Error("Konteks managed Skill load admission is unavailable"); };
    const verify = async input => {
      if (!selectedMessage || input?.sessionID !== selectedMessage.sessionID) {
        throw new Error("Konteks managed Skill load admission has no current native message");
      }
      const messages = input.messages.filter(message => message.id === selectedMessage.messageID && message.role === "user");
      if (messages.length !== 1) throw new Error("Konteks managed Skill load admission has no current native message");
      const parts = messages[0].content;
      if (!Array.isArray(parts) || expectedContent.some((text, index) => parts[index]?.type !== "text" || parts[index].text !== text)) {
        throw new Error("Konteks managed Skill content verification failed");
      }
      await deny();
    };
    const dispose = () => Promise.all(registrations.map(registration => registration.dispose()));
    try {
      for (const [name, callback] of [["prompt", select], ["context", verify], ["http.request", deny], ["experimental.ws.send", deny]]) {
        const registration = await context.session.hook(name, callback);
        if (typeof registration?.dispose !== "function") throw new Error("OpenCode native Skill hooks are unsupported");
        registrations.push(registration);
      }
      await send("ready");
    } catch (error) {
      await dispose();
      throw error;
    }
    return async () => {
      try { await send("closed"); } finally { await dispose(); }
    };
  }
};
`;
const unavailable = () => new RemoteInstanceError("agent_unavailable", "OpenCode managed Skill plugin activation is unavailable. Replace this execution context before retrying.");

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(unavailable());
      else resolve(address.port);
    });
  });
}
function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

/** Startup activation only. This acknowledgement never certifies a Skill load. */
export async function createOpenCodeActivation(configHome: string, skillRoots: readonly string[] = []) {
  const expectedContent = await openCodeSkillContent(skillRoots);
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(configHome, ".managed-plugin-"));
  const token = randomBytes(32).toString("hex");
  let active = false, closed = false, stopped = false;
  let turn: HostPromptTurn | undefined;
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const takeTurn = (response: ServerResponse) => {
    const current = turn;
    turn = undefined;
    if (!active || !current) { response.writeHead(403).end(); return; }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(current));
  };
  const server = createServer((request, response) => {
    request.resume();
    if (closed || stopped || request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end(); return;
    }
    if (request.url === "/turn") { takeTurn(response); return; }
    if (request.url !== "/ready" && request.url !== "/closed") {
      response.writeHead(404).end(); return;
    }
    active = request.url === "/ready";
    stopped = !active;
    resolveReady();
    response.writeHead(204).end();
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", main: "server.js" }), { mode: 0o600, flag: "wx" });
    await writeFile(join(directory, "skills.json"), JSON.stringify(expectedContent), { mode: 0o600, flag: "wx" });
    await writeFile(join(directory, "server.js"), source, { mode: 0o600, flag: "wx" });
    const port = await listen(server);
    server.unref();
    return {
      plugin: { package: directory, options: { endpoint: `http://127.0.0.1:${port}/ready`, token, skillFiles: skillRoots.map(root => join(root, "SKILL.md")) } },
      prepareTurn: (value?: HostPromptTurn) => {
        if (closed || !active) throw unavailable();
        turn = value ? Object.freeze({ ...value }) : undefined;
      },
      wait: async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([ready, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(unavailable()), 10_000); timer.unref();
          })]);
          if (closed || !active) throw unavailable();
        } finally { clearTimeout(timer); }
      },
      release: async () => {
        if (closed) return;
        closed = true; active = false; turn = undefined; resolveReady();
        try { await close(server); } finally { await rm(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    if (server.listening) await close(server);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
