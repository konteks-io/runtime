import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";

const source = `export default {
  id: "konteks-managed-skills-activation",
  async setup(context) {
    const { endpoint, token } = context.options;
    const send = async action => {
      const response = await fetch(endpoint.replace(/ready$/, action), {
        method: "POST", headers: { authorization: "Bearer " + token },
        redirect: "error", signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error("Konteks plugin activation was refused");
      await response.body?.cancel();
    };
    const registrations = [];
    const deny = async () => { throw new Error("Konteks managed Skill load admission is unavailable"); };
    const dispose = () => Promise.all(registrations.map(registration => registration.dispose()));
    try {
      for (const name of ["context", "http.request", "experimental.ws.send"]) {
        registrations.push(await context.session.hook(name, deny));
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
export async function createOpenCodeActivation(configHome: string) {
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(configHome, ".managed-plugin-"));
  const token = randomBytes(32).toString("hex");
  let active = false, closed = false, stopped = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    if (closed || stopped || request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end(); return;
    }
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
    await writeFile(join(directory, "server.js"), source, { mode: 0o600, flag: "wx" });
    const port = await listen(server);
    server.unref();
    return {
      plugin: { package: directory, options: { endpoint: `http://127.0.0.1:${port}/ready`, token } },
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
        closed = true; active = false; resolveReady();
        try { await close(server); } finally { await rm(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    if (server.listening) await close(server);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
