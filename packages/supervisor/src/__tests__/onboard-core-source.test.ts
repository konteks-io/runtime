import { it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { computeRemoteFileTreeDigest } from "@konteks/remote-common";
import { OnboardEvidenceCollector } from "../onboard/evidence-collector.js";
const bytes = Buffer.from(JSON.stringify({ name: "fixture" }));
const revision = "a".repeat(40);
const entry = { path: "package.json", mode: 0o600, sizeBytes: bytes.length, contentBase64: bytes.toString("base64"), digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };

it("reads connector-backed grouping source from Core without machine Git auth and uploads no bodies", async () => {
  const item = { canonicalKey: "git.example/acme/fixture", url: "https://git.example/acme/fixture", provider: "gitea", vcsConnectorId: "connector", repoOwner: "acme", repoName: "fixture", defaultBranch: "main", archived: false };
  const sourceFiles = vi.fn(async () => ({ revision, tree: { format: "konteks-file-tree-v1", entries: [entry], treeDigest: computeRemoteFileTreeDigest([entry]) } }));
  const evidenceSubmit = vi.fn(async () => undefined);
  const archiveFile = vi.fn(async () => { throw new Error("machine Git must not read this connector"); });
  const collector = new OnboardEvidenceCollector({
    coreSourceFiles: true, git: { archiveFile } as never, rawFiles: { read: async () => { throw new Error("no machine raw-file credential"); } },
    scratch: { clones: async () => [], archivePath: () => "/not-used" } as never,
    facade: { sourceFiles, inventoryList: async () => ({ items: [item], nextCursor: null }), evidenceSubmit } as never,
    resolveRemote: value => ({ url: value.url }),
  });
  await collector.collectGrouping({ runRef: "run", kind: "discovery", depth: "grouping", bounds: { maxFilesPerRepository: 12, maxRepositoriesDeep: 50, enrichmentTimeoutMinutes: 120 } });
  expect(sourceFiles).toHaveBeenCalledWith("run", item.canonicalKey);
  expect(archiveFile).not.toHaveBeenCalled();
  const submission = evidenceSubmit.mock.calls[0] as unknown as [string, Array<{ refs: Array<{ ref: string }>; facts: unknown }>];
  expect(submission[1][0]?.refs[0]?.ref).toContain(revision);
  expect(JSON.stringify(submission)).not.toMatch(/contentBase64|"body"|"content"/);
});

it("does not submit evidence when its claim is cancelled during the Core read", async () => {
  let current = true;
  const evidenceSubmit = vi.fn(async () => undefined);
  const item = { canonicalKey: "git.example/acme/fixture", url: "https://git.example/acme/fixture", provider: "gitea", vcsConnectorId: "connector", repoOwner: "acme", repoName: "fixture", defaultBranch: "main", archived: false };
  const collector = new OnboardEvidenceCollector({
    coreSourceFiles: true, git: {} as never, rawFiles: {} as never,
    scratch: { clones: async () => [] } as never,
    facade: {
      sourceFiles: async () => { current = false; return { revision, tree: { format: "konteks-file-tree-v1", entries: [entry], treeDigest: computeRemoteFileTreeDigest([entry]) } }; },
      inventoryList: async () => ({ items: [item], nextCursor: null }), evidenceSubmit,
    } as never,
    resolveRemote: value => ({ url: value.url }),
  });
  await expect(collector.collectGrouping({ runRef: "run", kind: "discovery", depth: "grouping", bounds: { maxFilesPerRepository: 12, maxRepositoriesDeep: 50, enrichmentTimeoutMinutes: 120 } }, () => {
    if (!current) throw new Error("claim cancelled");
  })).rejects.toThrow("claim cancelled");
  expect(evidenceSubmit).not.toHaveBeenCalled();
});
