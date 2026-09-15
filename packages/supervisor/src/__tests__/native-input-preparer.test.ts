import { createHash, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, symlink, rename, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReleaseFixture } from "@konteks/remote-release";
import {
  FixedClock,
  computeRemoteFileTreeDigest,
  computeRemoteSkillCatalogDigest,
  computeRemoteAssignmentInputSelectionDigest,
  remoteControlSigningBytes,
  type RemoteWorkAssignment,
} from "@konteks/remote-common";
import { NativeInputClient } from "../native/input-client.js";
import { createNativeInputPreparer } from "../native/input-preparer.js";
import { StateMutationGate } from "../state/mutation-gate.js";
import { testGitCommand, testGitTool } from "./native-git-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const now = Date.parse("2026-09-06T01:00:00Z");
const binding = {
  workspaceId: "tenant",
  sessionId: "session",
  assignmentId: "assignment",
  attempt: 1,
  instanceId: "instance",
};
const assignment: RemoteWorkAssignment = {
  id: "assignment",
  instanceId: "instance",
  workspaceId: "tenant",
  attempt: 1,
  kind: "assistant_execution",
  placementId: "placement",
  taskId: "task",
  correlationId: "correlation",
  expiresAt: "2026-09-06T02:00:00Z",
  requiredCapabilities: [],
  agentRoute: { agentId: "codex", requiredRole: "assistant" },
  source: {
    kind: "conversation",
    portability: "portable_before_claim",
    sessionId: "session",
    turnRef: "turn",
  },
  policy: {
    maxDurationSeconds: 600,
    maxArtifactBytes: 1024,
    evidenceUpload: "structured_only",
    allowedArtifactKinds: [],
    recoveryMode: "report_interrupted",
    latestResumeAt: "2026-09-06T02:00:00Z",
    permissionResponderDeadlineSeconds: 30,
    humanDeferralAllowed: false,
  },
};
function tree(files: Record<string, string>) {
  const entries = Object.entries(files).map(([path, text]) => ({
    path,
    mode: 0o600,
    sizeBytes: Buffer.byteLength(text),
    digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    contentBase64: Buffer.from(text).toString("base64"),
  }));
  return {
    format: "konteks-file-tree-v1",
    treeDigest: computeRemoteFileTreeDigest(entries),
    entries,
  };
}
async function fixture(sourceFiles: Record<string, string> = { "src/app.txt": "original" }) {
  const root = await mkdtemp(join(tmpdir(), "konteks-native-input-"));
  roots.push(root);
  const keys = buildReleaseFixture(),
    clock = new FixedClock(now);
  const sourceTree = tree(sourceFiles),
    skillTree = tree({
      "SKILL.md": "Read references/guide.md",
      "references/guide.md": "Full reference",
    });
  const manifest = (id: string, purpose: string, body: ReturnType<typeof tree>) => ({
    version: 1,
    transferId: id,
    binding,
    direction: "to_runtime",
    purpose,
    revision: "revision",
    artifactRef: `artifact:${id}`,
    treeDigest: body.treeDigest,
    sizeBytes: body.entries.reduce((sum, e) => sum + e.sizeBytes, 0),
    fileCount: body.entries.length,
    expiresAt: "2026-09-06T02:00:00Z",
  });
  const catalog = {
    version: 1,
    binding,
    skills: [
      {
        skillId: "review",
        version: "1",
        name: "review",
        description: "Review",
        required: true,
        transfer: manifest("skill", "organization_skill", skillTree),
      },
    ],
  };
  const selection = {
    version: 1,
    binding,
    claimId: "claim",
    source: manifest("source", "source", sourceTree),
    skills: { ...catalog, catalogDigest: computeRemoteSkillCatalogDigest(catalog) },
  };
  const response = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  let allowed = true,
    claim: string | null = "claim";
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (!allowed) return new Response(null, { status: 403 });
    if (String(url).endsWith("/prepare")) {
      const unsigned = {
        type: "assignment_inputs",
        instanceId: "instance",
        selection,
        selectionDigest: computeRemoteAssignmentInputSelectionDigest(selection),
        issuedAt: new Date(clock.coreNow()).toISOString(),
        expiresAt: new Date(clock.coreNow() + 300_000).toISOString(),
      };
      return response({
        ...unsigned,
        signature: sign(null, remoteControlSigningBytes(unsigned), keys.privateKey).toString(
          "base64url",
        ),
      });
    }
    return response(
      JSON.parse(String(init?.body)).transferId === "source" ? sourceTree : skillTree,
    );
  });
  const options = {
    root,
    clock,
    claimId: () => claim,
    client: () =>
      new NativeInputClient({
        baseUrl: "https://core.example",
        roots: [
          {
            ...keys.root,
            coreControlKeys: [{ keyId: keys.keyId, publicKeyJwk: keys.root.publicKeyJwk }],
          },
        ],
        clock,
        credential: () => "test-lease",
        fetchFn,
      }),
  };
  return {
    root,
    options,
    fetchFn,
    selection,
    sourceTree,
    clock,
    revoke: () => {
      allowed = false;
    },
    unclaim: () => {
      claim = null;
    },
  };
}

describe("native authorized input composition", () => {
  it("initializes Git for a repository source and preserves its baseline and edits on restart", async () => {
    const f = await fixture(),
      git = await testGitTool();
    f.selection.source.revision = "a".repeat(40);
    const target: RemoteWorkAssignment = {
      ...assignment,
      kind: "delivery",
      agentRoute: { agentId: "codex", requiredRole: "planner" },
      source: {
        kind: "repository_snapshot",
        portability: "portable_before_claim",
        repositoryRef: "repository",
        revision: f.selection.source.revision,
      },
    };
    const prepare = createNativeInputPreparer({ ...f.options, git });
    const first = await prepare(target);
    expect(await readFile(join(first.cwd, ".git"), "utf8")).toBe("gitdir: ../git\n");
    const receiptPath = join(dirname(first.cwd), "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    expect(receipt.git.baseCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(receipt.source.revision).toBe(f.selection.source.revision);
    expect(await testGitCommand(git, first.cwd, ["status", "--porcelain"])).toBe("");
    expect((await testGitCommand(git, first.cwd, ["rev-parse", "HEAD"])).trim()).toBe(
      receipt.git.baseCommit,
    );
    await writeFile(join(first.cwd, "src/app.txt"), "local edits");
    const resumed = await createNativeInputPreparer({ ...f.options, git })(target);
    expect(resumed.cwd).toBe(first.cwd);
    expect(JSON.parse(await readFile(receiptPath, "utf8")).git).toEqual(receipt.git);
    expect(await readFile(join(resumed.cwd, "src/app.txt"), "utf8")).toBe("local edits");
    await resumed.beforePrompt();
  });
  it("refuses a repository source without installer-selected Git", async () => {
    const f = await fixture();
    f.selection.source.revision = "a".repeat(40);
    const target: RemoteWorkAssignment = {
      ...assignment,
      kind: "delivery",
      agentRoute: { agentId: "codex", requiredRole: "planner" },
      source: {
        kind: "repository_snapshot",
        portability: "portable_before_claim",
        repositoryRef: "repository",
        revision: f.selection.source.revision,
      },
    };
    await expect(createNativeInputPreparer(f.options)(target)).rejects.toThrow();
  });
  it("materializes source and full skills outside it using the verified HTTP client", async () => {
    const f = await fixture();
    const prepared = await createNativeInputPreparer(f.options)(assignment);
    expect(await readFile(join(prepared.cwd, "src/app.txt"), "utf8")).toBe("original");
    const skill = JSON.parse(
      prepared.skillInstructions.split("\n").find((line) => line.startsWith("{"))!,
    );
    expect(skill.skillFile.startsWith(`${prepared.cwd}/`)).toBe(false);
    expect(await readFile(join(dirname(skill.skillFile), "references/guide.md"), "utf8")).toBe(
      "Full reference",
    );
    expect(prepared.binding).toEqual(binding);
    expect(await readdir(prepared.cwd)).toEqual(["src"]);
    await prepared.beforePrompt();
  });
  it("preserves local edits on reprepare/restart and never refetches an existing source", async () => {
    const f = await fixture();
    const first = await createNativeInputPreparer(f.options)(assignment);
    await writeFile(join(first.cwd, "src/app.txt"), "local work");
    f.fetchFn.mockClear();
    const resumed = await createNativeInputPreparer(f.options)(assignment);
    expect(resumed.cwd).toBe(first.cwd);
    expect(await readFile(join(resumed.cwd, "src/app.txt"), "utf8")).toBe("local work");
    expect(f.fetchFn.mock.calls.every(([url]) => String(url).endsWith("/prepare"))).toBe(true);
    await resumed.beforePrompt();
  });
  it("rechecks remote and local claim authority before prompts, including cached inputs", async () => {
    const f = await fixture(),
      prepared = await createNativeInputPreparer(f.options)(assignment);
    f.revoke();
    await expect(prepared.beforePrompt()).rejects.toMatchObject({ code: "capability_unavailable" });
    const g = await fixture(),
      other = await createNativeInputPreparer(g.options)(assignment);
    g.unclaim();
    await expect(other.beforePrompt()).rejects.toThrow();
  });
  it("requires a local claim before fetching or staging", async () => {
    const f = await fixture();
    f.unclaim();
    await expect(createNativeInputPreparer(f.options)(assignment)).rejects.toThrow();
    expect(f.fetchFn).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  });
  it.each([".git/config", "nested/.GIT/hooks/run", "GIT~1/config"])(
    "never imports repository metadata %s",
    async (path) => {
      const f = await fixture({ [path]: "unsafe" });
      await expect(createNativeInputPreparer(f.options)(assignment)).rejects.toMatchObject({
        code: "capability_unavailable",
      });
    },
  );
  it("rejects a replaced or linked workspace without touching its target", async () => {
    const f = await fixture(),
      prepared = await createNativeInputPreparer(f.options)(assignment);
    await rename(prepared.cwd, `${prepared.cwd}-saved`);
    await symlink(`${prepared.cwd}-saved`, prepared.cwd, "dir");
    await expect(prepared.beforePrompt()).rejects.toThrow();
    await expect(createNativeInputPreparer(f.options)(assignment)).rejects.toThrow();
    expect(await readFile(join(`${prepared.cwd}-saved`, "src/app.txt"), "utf8")).toBe("original");
  });
  it("rejects changed signed selection rather than overwriting a dirty checkout", async () => {
    const f = await fixture(),
      prepared = await createNativeInputPreparer(f.options)(assignment);
    await writeFile(join(prepared.cwd, "src/app.txt"), "local work");
    f.selection.source.revision = "substituted";
    await expect(createNativeInputPreparer(f.options)(assignment)).rejects.toThrow();
    expect(await readFile(join(prepared.cwd, "src/app.txt"), "utf8")).toBe("local work");
  });
  it("rejects skill corruption before another prompt", async () => {
    const f = await fixture(),
      prepared = await createNativeInputPreparer(f.options)(assignment);
    const skill = JSON.parse(
      prepared.skillInstructions.split("\n").find((line) => line.startsWith("{"))!,
    );
    await writeFile(skill.skillFile, "changed");
    await expect(prepared.beforePrompt()).rejects.toThrow();
  });
  it("supports an explicitly authorized empty conversation source", async () => {
    const f = await fixture({});
    const prepared = await createNativeInputPreparer(f.options)(assignment);
    expect(await readdir(prepared.cwd)).toEqual([]);
    await prepared.beforePrompt();
  });
  it("renews the authorization window without replacing files or the selection", async () => {
    const f = await fixture(),
      prepared = await createNativeInputPreparer(f.options)(assignment);
    f.clock.advance(300_001);
    await prepared.beforePrompt();
    const last = f.fetchFn.mock.calls.at(-1)!;
    expect(JSON.parse(String(last[1]?.body)).selectionDigest).toBe(
      computeRemoteAssignmentInputSelectionDigest(f.selection),
    );
  });
  it("refuses a tampered receipt and does not rewrite it", async () => {
    const f = await fixture(),
      prepared = await createNativeInputPreparer(f.options)(assignment);
    const receipt = join(dirname(prepared.cwd), "receipt.json");
    await writeFile(receipt, "{}");
    await expect(prepared.beforePrompt()).rejects.toThrow();
    await expect(createNativeInputPreparer(f.options)(assignment)).rejects.toThrow();
    expect(await readFile(receipt, "utf8")).toBe("{}");
  });
  it("fences preparation and before-prompt writes after native ownership shutdown", async () => {
    const f = await fixture();
    const gate = new StateMutationGate(() => undefined);
    const prepare = createNativeInputPreparer({ ...f.options, mutate: gate.run });
    const prepared = await prepare(assignment);
    await gate.close();
    f.fetchFn.mockClear();
    await expect(prepared.beforePrompt()).rejects.toThrow();
    await expect(prepare(assignment)).rejects.toThrow();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
});
