import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  isProcessGroupAlive,
  killProcessGroup,
  runCommand,
  sanitizeInheritedChildProcessEnv,
  spawnPiped,
  stopProcessGroupLeaderFirst,
} from "../process.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

posixOnly("subprocess tree lifecycle (bridge termination)", () => {
  it("kills the grandchild when the leader is signalled by process group", async () => {
    const child = spawnPiped({
      command: "sh",
      args: ["-c", "sleep 300 & echo $!; wait"],
      detached: true,
    });
    const [chunk] = await once(child.stdout, "data");
    const grandchild = Number(String(chunk).trim());
    expect(isAlive(grandchild)).toBe(true);
    const exited = once(child, "exit");
    killProcessGroup(child, "SIGKILL");
    await waitFor(() => !isAlive(grandchild));
    await exited;
    expect(isProcessGroupAlive(child)).toBe(false);
  });

  it("stops the leader first then escalates to SIGKILL for a trap-ignoring child", async () => {
    const child = spawnPiped({ command: "sh", args: ["-c", "trap '' TERM; sleep 300"], detached: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stopProcessGroupLeaderFirst({ child, timeoutMs: 200, killGraceMs: 500 });
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("runs a command with bounded output capture", async () => {
    const result = await runCommand({
      command: "sh",
      args: ["-c", "printf abc; printf err 1>&2; exit 3"],
      outputCapBytes: 2,
    });
    expect(result).toMatchObject({ code: 3, stdout: "ab", stderr: "er" });
  });
});

describe("child environment sanitization", () => {
  it("removes provider keys and Konteks material unless explicitly allowed", () => {
    const env = sanitizeInheritedChildProcessEnv({
      env: {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "sk-ant-x",
        OPENAI_API_KEY: "sk-x",
        KONTEKS_LEASE: "lease",
        MY_TOKEN: "t",
        HOME: "/home/agent",
        NODE_OPTIONS: "--inspect",
      },
      allow: ["KONTEKS_LEASE"],
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/agent", KONTEKS_LEASE: "lease" });
  });
});
