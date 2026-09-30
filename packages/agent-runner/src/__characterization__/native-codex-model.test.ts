import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { expect, it } from "vitest";

/** Opt-in authenticated check against the exact Codex binary bundled for a
 * native connector. No cloud assignment, tools, or workspace files are used. */
const binary = process.env.NATIVE_CODEX_MODEL_PROBE_BINARY;

it.skipIf(!binary)(
  "completes a ChatGPT-account turn with the connector Codex model",
  () => {
    const result = spawnSync(
      binary!,
      [
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "-C",
        tmpdir(),
        "-m",
        "gpt-6-sol",
        "Reply exactly OK. Do not use tools.",
      ],
      {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 64 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: homedir(),
          CODEX_HOME: process.env.CODEX_HOME ?? `${homedir()}/.codex`,
          LANG: "C.UTF-8",
          TERM: "dumb",
          NO_COLOR: "1",
          CI: "1",
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\bOK\.?\b/);
  },
  70_000,
);
