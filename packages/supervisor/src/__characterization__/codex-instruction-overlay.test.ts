import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareCodexHomeOverlay } from "../native/codex-home-overlay.js";

/**
 * The real Codex CLI's model-visible prompt input, not the bridge's config
 * keys. `CODEX_BIN` points at an installed Codex (the offline package or the
 * person's own). The overlay must keep the operator's user instructions out
 * while the working copy's own AGENTS.md still reaches the model.
 */
const CODEX = process.env.CODEX_BIN;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function promptInput(codexHome: string, cwd: string, home: string, extra: string[] = []): string {
  return execFileSync(CODEX!, ["debug", "prompt-input", ...extra, "hello"], {
    cwd,
    env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** A Codex version may reject a config feature; that case is simply not characterized. */
function tryPromptInput(codexHome: string, cwd: string, home: string, extra: string[] = []): string | null {
  try {
    return promptInput(codexHome, cwd, home, extra);
  } catch {
    return null;
  }
}

it.skipIf(!CODEX)("the real Codex prompt input loads the working copy but no operator or parent instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-instruction-characterization-"));
  roots.push(root);
  const real = join(root, "operator-codex");
  const work = join(root, "work");
  const bare = join(root, "bare");
  const overlay = join(root, "overlay");
  const home = join(root, "home");
  await mkdir(real, { recursive: true });
  await mkdir(work, { recursive: true });
  await mkdir(bare, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(real, "AGENTS.md"), "OPERATOR_AGENTS_MARKER\n");
  await writeFile(join(real, "AGENTS.override.md"), "OPERATOR_OVERRIDE_MARKER\n");
  await mkdir(join(real, "memories"), { recursive: true });
  await writeFile(join(real, "memories", "note.md"), "OPERATOR_MEMORY_MARKER\n");
  await mkdir(join(real, "skills", "personal"), { recursive: true });
  await writeFile(join(real, "skills", "personal", "SKILL.md"), "PERSONAL_SKILL_MARKER\n");
  await mkdir(join(real, "prompts"), { recursive: true });
  await writeFile(join(real, "prompts", "personal.md"), "PERSONAL_PROMPT_MARKER\n");
  await writeFile(join(real, "model-instructions.md"), "OPERATOR_MODEL_FILE_MARKER\n");
  await writeFile(join(real, "config.toml"), [
    'developer_instructions = "OPERATOR_CONFIG_MARKER"',
    `model_instructions_file = "${join(real, "model-instructions.md")}"`,
    "",
  ].join("\n"));
  await writeFile(join(root, "AGENTS.md"), "PARENT_DIRECTORY_MARKER\n");
  await writeFile(join(work, "AGENTS.md"), "WORKING_COPY_MARKER\n");
  await prepareCodexHomeOverlay(real, overlay);

  const direct = promptInput(real, work, home);
  expect(direct).toContain("OPERATOR_OVERRIDE_MARKER");
  expect(direct).toContain("OPERATOR_CONFIG_MARKER");
  expect(direct).toContain("OPERATOR_MODEL_FILE_MARKER");
  expect(direct).toContain("WORKING_COPY_MARKER");
  // A working copy with no AGENTS.md has no working-copy instructions; the
  // overlay still excludes the operator's own.
  const bareDirect = promptInput(real, bare, home);
  expect(bareDirect).toContain("OPERATOR_OVERRIDE_MARKER");
  expect(bareDirect).toContain("OPERATOR_CONFIG_MARKER");
  expect(bareDirect).toContain("OPERATOR_MODEL_FILE_MARKER");

  const overlayed = promptInput(overlay, work, home);
  expect(overlayed).toContain("WORKING_COPY_MARKER");
  for (const marker of ["OPERATOR_AGENTS_MARKER", "OPERATOR_OVERRIDE_MARKER", "OPERATOR_MEMORY_MARKER", "OPERATOR_CONFIG_MARKER",
    "OPERATOR_MODEL_FILE_MARKER", "PERSONAL_SKILL_MARKER", "PERSONAL_PROMPT_MARKER"]) {
    expect(overlayed).not.toContain(marker);
  }

  // The thread config bounds the parent walk and always sets
  // developer_instructions, including empty when the working copy has none.
  const scopedBare = promptInput(overlay, bare, home, ["-c", "project_doc_max_bytes=0", "-c", 'developer_instructions=""']);
  for (const marker of ["OPERATOR_AGENTS_MARKER", "OPERATOR_OVERRIDE_MARKER", "OPERATOR_MEMORY_MARKER", "OPERATOR_CONFIG_MARKER", "OPERATOR_MODEL_FILE_MARKER", "PARENT_DIRECTORY_MARKER"]) {
    expect(scopedBare).not.toContain(marker);
  }
  const scopedWork = promptInput(overlay, bare, home, ["-c", "project_doc_max_bytes=0", "-c", 'developer_instructions="WORKING_COPY_MARKER"']);
  expect(scopedWork).toContain("WORKING_COPY_MARKER");
  for (const marker of ["OPERATOR_AGENTS_MARKER", "OPERATOR_OVERRIDE_MARKER", "OPERATOR_MEMORY_MARKER", "OPERATOR_CONFIG_MARKER", "OPERATOR_MODEL_FILE_MARKER", "PARENT_DIRECTORY_MARKER"]) {
    expect(scopedWork).not.toContain(marker);
  }

  // A selected profile's model_instructions_file is the same leak in another
  // spelling. Older Codex accepted `profile =`; a version that rejects it is
  // simply not characterized here, while the sanitizer unit test covers it.
  const profileReal = join(root, "profile-codex");
  const profileOverlay = join(root, "profile-overlay");
  await mkdir(profileReal, { recursive: true });
  await writeFile(join(profileReal, "profile-instructions.md"), "OPERATOR_PROFILE_FILE_MARKER\n");
  await writeFile(join(profileReal, "config.toml"), [
    'profile = "work"',
    "",
    "[profiles.work]",
    `model_instructions_file = "${join(profileReal, "profile-instructions.md")}"`,
    "",
  ].join("\n"));
  await prepareCodexHomeOverlay(profileReal, profileOverlay);
  const profileDirect = tryPromptInput(profileReal, bare, home);
  if (profileDirect !== null) {
    expect(profileDirect).toContain("OPERATOR_PROFILE_FILE_MARKER");
    const profileScoped = tryPromptInput(profileOverlay, bare, home, ["-c", "project_doc_max_bytes=0", "-c", 'developer_instructions=""']);
    expect(profileScoped).not.toBeNull();
    expect(profileScoped).not.toContain("OPERATOR_PROFILE_FILE_MARKER");
  }
});
