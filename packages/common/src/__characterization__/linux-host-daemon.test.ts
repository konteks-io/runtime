import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLinuxExecutionSpawner } from "../linux-execution-process.js";
import { stopProcessGroupLeaderFirst, type PipedChildProcess } from "../process.js";

const enabled = process.platform === "linux" && process.env.NATIVE_LINUX_CONTAINMENT_CHARACTERIZE === "1";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Negative qualification evidence: passing this test proves an ownership gap,
// NOT successful containment of arbitrary host tools/MCP servers.
it.skipIf(!enabled)("cannot claim quiescence for work accepted by an external host socket daemon", async () => {
  // /var/tmp is visible through the read-only host mount, unlike private /tmp.
  // The socket is outside the sole writable workspace mount.
  const root = await mkdtemp("/var/tmp/native-host-daemon-");
  const workspace = join(root, "workspace");
  const socketPath = join(root, "daemon.sock"), output = join(workspace, "writes");
  const sockets = new Set<Socket>();
  let writer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let child: PipedChildProcess | undefined;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", data => {
      if (data.toString() !== "start" || writer) return socket.end();
      writer = setInterval(() => appendFileSync(output, "x"), 25);
      // Independent deadline also bounds the daemon if an assertion fails.
      deadline = setTimeout(() => clearInterval(writer), 3_000);
      socket.end("accepted");
    });
  });
  try {
    await mkdir(workspace);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    child = createLinuxExecutionSpawner({ executable: "/usr/bin/bwrap", writableRoots: [workspace] })({
      command: process.execPath,
      args: ["-e", `const net = require('node:net');
        const socket = net.connect(process.argv[1], () => socket.write('start'));
        socket.on('error', () => process.exit(2));
        socket.on('data', () => process.stdout.write('accepted'));
        setTimeout(() => process.exit(0), 5000);`, socketPath],
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    const spawned = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture daemon acceptance timed out")), 2_000);
      spawned.once("error", error => { clearTimeout(timer); reject(error); });
      spawned.stdout.once("data", data => {
        clearTimeout(timer);
        if (data.toString() === "accepted") resolve();
        else reject(new Error("fixture daemon did not accept"));
      });
    });
    await stopProcessGroupLeaderFirst({ child, timeoutMs: 500, killGraceMs: 500 });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await pause(75);
    const before = (await readFile(output)).length;
    await pause(150);
    expect((await readFile(output)).length).toBeGreaterThan(before);
  } finally {
    if (writer) clearInterval(writer);
    if (deadline) clearTimeout(deadline);
    if (child) await stopProcessGroupLeaderFirst({ child, timeoutMs: 500, killGraceMs: 500 });
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
