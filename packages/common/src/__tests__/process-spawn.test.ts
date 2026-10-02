import { once } from "node:events";
import { spawn } from "node:child_process";
import { expect, it, vi } from "vitest";
import { spawnPiped } from "../process.js";

vi.mock("node:child_process", { spy: true });

it("runs background probes with no Windows console while preserving piped output and exit status", async () => {
  const child = spawnPiped({ command: process.execPath, args: ["-e", "process.stdout.write('probe'); process.exitCode=3"], detached: false });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.resume();
  const [code] = await once(child, "close");
  expect(stdout).toBe("probe");
  expect(code).toBe(3);
  expect(spawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({ windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"] }));
});
