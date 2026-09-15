import { expect, it, vi } from "vitest";
import { createLinuxExecutionSpawner } from "../linux-execution-process.js";
import { spawnPiped } from "../process.js";
vi.mock("../process.js", () => ({ spawnPiped: vi.fn(() => ({})) }));

it.skipIf(process.platform !== "linux")("captures the mount policy and wraps only the selected absolute command", () => {
  const policy = { executable: "/usr/bin/bwrap", writableRoots: ["/owned/work"] };
  const spawn = createLinuxExecutionSpawner(policy);
  policy.writableRoots.push("/later"); policy.executable = "/other";
  spawn({ command: "/owned/bin/agent", args: ["--mode", "agent"], cwd: "/owned/work", env: { LANG: "C" } });
  expect(spawnPiped).toHaveBeenLastCalledWith({ command: "/usr/bin/bwrap", detached: true, cwd: "/owned/work", env: { LANG: "C" },
    args: ["--ro-bind", "/", "/", "--unshare-user", "--unshare-pid", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/run", "--tmpfs", "/tmp",
      "--bind", "/owned/work", "/owned/work", "--die-with-parent", "--new-session", "--", "/owned/bin/agent", "--mode", "agent"] });
});

it.skipIf(process.platform !== "linux").each(["/", "/proc", "/dev", "/tmp", "/run", "relative", "/work/../other"])("rejects invalid writable mount %s", root => {
  expect(() => createLinuxExecutionSpawner({ executable: "/usr/bin/bwrap", writableRoots: [root] })).toThrow();
});

it.skipIf(process.platform !== "linux")("never registry-resolves a relative command", () => {
  const spawn = createLinuxExecutionSpawner({ executable: "/usr/bin/bwrap", writableRoots: ["/owned/work"] });
  expect(() => spawn({ command: "agent", args: [] })).toThrow();
});
