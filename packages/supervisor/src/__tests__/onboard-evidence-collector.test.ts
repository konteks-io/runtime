import { describe, expect, it, vi } from "vitest";
import type { DiscoveryEvidenceSubmission, DiscoveryInventoryItem } from "@konteks/remote-common";
import { OnboardEvidenceCollector } from "../onboard/evidence-collector.js";
import { evidenceCandidates } from "../onboard/evidence-paths.js";
import { extractFacts, parseCodeowners, parseDescriptor } from "../onboard/facts.js";
import { requireBounds, type OnboardFacade, type OnboardRunView } from "../onboard/facade.js";
import { gitGap, gitOk, type GitRemote } from "../onboard/git.js";
import { resolveRemote } from "../onboard/remotes.js";

const bounds = { maxFilesPerRepository: 6, maxRepositoriesDeep: 3, enrichmentTimeoutMinutes: 120 };

function inventory(count: number): DiscoveryInventoryItem[] {
  return Array.from({ length: count }, (_unused, index) => ({
    canonicalKey: `git.example.com/acme/service-${index}`,
    url: `https://git.example.com/acme/service-${index}`,
    defaultBranch: "main",
    archived: false,
    vcsConnectorId: "connector-1",
    provider: "github",
    repoOwner: "acme",
    repoName: `service-${index}`,
  }));
}

interface Recorded {
  submitted: DiscoveryEvidenceSubmission[];
  enriched: DiscoveryEvidenceSubmission[];
  progress: Array<{ canonicalKey: string; state: string }>;
}

function facade(items: DiscoveryInventoryItem[], pageSize = 50): { facade: OnboardFacade; recorded: Recorded } {
  const recorded: Recorded = { submitted: [], enriched: [], progress: [] };
  const pages: DiscoveryInventoryItem[][] = [];
  for (let index = 0; index < items.length; index += pageSize) pages.push(items.slice(index, index + pageSize));
  return {
    recorded,
    facade: {
      runGet: async () => requireBounds({ runRef: "run-1", kind: "discovery", depth: "grouping", bounds }),
      inventoryList: async (_runRef, cursor) => {
        const page = cursor === undefined ? 0 : Number(cursor);
        return { items: pages[page] ?? [], nextCursor: pages[page + 1] ? String(page + 1) : null };
      },
      evidenceSubmit: async (_runRef, evidence) => void recorded.submitted.push(...evidence),
      enrichmentSubmit: async (_runRef, _systemRef, evidence) => void recorded.enriched.push(...evidence),
      enrichmentProgress: async (_runRef, progress) => void recorded.progress.push(progress),
      relocationStatus: async () => {
        throw new Error("not used");
      },
      relocationReport: async () => {
        throw new Error("not used");
      },
    },
  };
}

const PACKAGE_JSON = Buffer.from(JSON.stringify({ name: "@acme/service", workspaces: ["packages/*"], dependencies: { left: "1.0.0" } }));
const CODEOWNERS = Buffer.from("# reviewed by the platform guild BODY-MARKER\n*  @acme/platform  @acme/sre\ndocs/ @acme/writers\n");

function scratch() {
  const clones = new Set<string>();
  return {
    clonesRoot: "/scratch/clones",
    archivesRoot: "/scratch/archives",
    archivePath: (name: string) => `/scratch/archives/${name}.tar`,
    reserveClone: vi.fn(async (name: string) => {
      clones.add(name);
      return `/scratch/clones/${name}`;
    }),
    releaseClone: vi.fn(async (name: string) => void clones.delete(name)),
    clones: vi.fn(async () => [...clones]),
    readCloned: vi.fn(async (_name: string, path: string) => (path === "package.json" ? PACKAGE_JSON : null)),
    live: clones,
  };
}

describe("grouping depth", () => {
  it("reads at most maxFilesPerRepository files per repository and never clones", async () => {
    const items = inventory(50);
    const { facade: port, recorded } = facade(items);
    const reads: string[] = [];
    const git = {
      version: async () => "2.45.2",
      lsRemote: async () => gitOk([]),
      archiveFile: vi.fn(async (_remote: GitRemote, _ref: string, path: string) => {
        reads.push(path);
        if (path === "package.json") return gitOk(PACKAGE_JSON);
        if (path === ".github/CODEOWNERS") return gitOk(CODEOWNERS);
        return gitGap<Buffer>("not_found", "absent");
      }),
      credential: async () => gitGap<{ username: string; password: string }>("credential_unavailable", "sign in"),
      cloneShallow: vi.fn(async () => gitOk(undefined)),
      cloneMirror: async () => gitOk(undefined),
      pushMirror: async () => gitOk(undefined),
    };
    const disk = scratch();
    const collector = new OnboardEvidenceCollector({
      git: git as never,
      rawFiles: { read: async () => gitGap<Buffer>("not_found", "absent") },
      scratch: disk as never,
      facade: port,
      resolveRemote: item => ({ url: item.url }),
    });

    const run: OnboardRunView = { runRef: "run-1", kind: "discovery", depth: "grouping", bounds };
    const outcome = await collector.collectGrouping(run);

    expect(outcome.submitted).toBe(50);
    expect(recorded.submitted).toHaveLength(50);
    // Exactly the bound, per repository, and never more.
    expect(reads).toHaveLength(50 * bounds.maxFilesPerRepository);
    expect(git.cloneShallow).not.toHaveBeenCalled();
    expect(disk.live.size).toBe(0);
  });

  it("submits hashes and refs, and never a body", async () => {
    const items = inventory(1);
    const { facade: port, recorded } = facade(items);
    const collector = new OnboardEvidenceCollector({
      git: {
        version: async () => "2.45.2",
        lsRemote: async () => gitOk([]),
        archiveFile: async (_remote, _ref, path) => (path === ".github/CODEOWNERS" ? gitOk(CODEOWNERS) : gitGap<Buffer>("not_found", "absent")),
        credential: async () => gitGap<{ username: string; password: string }>("credential_unavailable", "sign in"),
        cloneShallow: async () => gitOk(undefined),
        cloneMirror: async () => gitOk(undefined),
        pushMirror: async () => gitOk(undefined),
      },
      rawFiles: { read: async () => gitGap<Buffer>("not_found", "absent") },
      scratch: scratch() as never,
      facade: port,
      resolveRemote: item => ({ url: item.url }),
    });

    await collector.collectGrouping({ runRef: "run-1", kind: "discovery", depth: "grouping", bounds });

    const submission = recorded.submitted[0]!;
    expect(submission.refs).toEqual([
      {
        ref: "git.example.com/acme/service-0@main:.github/CODEOWNERS",
        kind: "codeowners",
        path: ".github/CODEOWNERS",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown as string,
      },
    ]);
    expect(submission.facts.codeowners?.handles).toEqual(["@acme/platform", "@acme/sre", "@acme/writers"]);
    // The hashes prove which bytes were read; the bytes themselves stay here.
    expect(JSON.stringify(submission)).not.toContain("BODY-MARKER");
  });

  it("falls back to the raw-file API when the host disables git archive, and records which path won", async () => {
    const items = inventory(1);
    const { facade: port } = facade(items);
    const raw = vi.fn(async () => gitOk(PACKAGE_JSON));
    const collector = new OnboardEvidenceCollector({
      git: {
        version: async () => "2.45.2",
        lsRemote: async () => gitOk([]),
        // GitHub answers every `git archive --remote` this way.
        archiveFile: async () => gitGap<Buffer>("not_found", "archive is disabled on this host"),
        credential: async () => gitOk({ username: "x-access-token", password: "secret" }),
        cloneShallow: async () => gitOk(undefined),
        cloneMirror: async () => gitOk(undefined),
        pushMirror: async () => gitOk(undefined),
      },
      rawFiles: { read: raw as never },
      scratch: scratch() as never,
      facade: port,
      resolveRemote: item => ({ url: item.url }),
    });

    const outcome = await collector.collectGrouping({ runRef: "run-1", kind: "discovery", depth: "grouping", bounds });
    expect(outcome.submitted).toBe(1);
    expect(raw).toHaveBeenCalledTimes(bounds.maxFilesPerRepository);
  });

  it("reports a side it cannot read as an evidence gap and stops spending reads on it", async () => {
    const items = inventory(1);
    const { facade: port, recorded } = facade(items);
    const archiveFile = vi.fn(async () => gitGap<Buffer>("credential_unavailable", "sign in to this provider"));
    const collector = new OnboardEvidenceCollector({
      git: {
        version: async () => "2.45.2",
        lsRemote: async () => gitOk([]),
        archiveFile: archiveFile as never,
        credential: async () => gitGap<{ username: string; password: string }>("credential_unavailable", "sign in"),
        cloneShallow: async () => gitOk(undefined),
        cloneMirror: async () => gitOk(undefined),
        pushMirror: async () => gitOk(undefined),
      },
      rawFiles: { read: async () => gitGap<Buffer>("not_found", "absent") },
      scratch: scratch() as never,
      facade: port,
      resolveRemote: item => ({ url: item.url }),
    });

    const outcome = await collector.collectGrouping({ runRef: "run-1", kind: "discovery", depth: "grouping", bounds });

    expect(outcome.unreadable).toEqual([{ canonicalKey: "git.example.com/acme/service-0", gap: { code: "credential_unavailable", remedy: "sign in to this provider" } }]);
    // One refusal answers for the whole repository; the run does not retry the
    // same credential five more times.
    expect(archiveFile).toHaveBeenCalledTimes(1);
    // The repository still has a row: an unreadable repository is a fact,
    // and it says why and what a person does about it (W2-O3).
    expect(recorded.submitted[0]!.refs).toEqual([]);
    expect(recorded.submitted[0]).toMatchObject({ gap: { code: "credential_unavailable", remedy: "sign in to this provider" } });
  });

  it("refuses a run whose bounds are absent rather than choosing its own", () => {
    expect(() => requireBounds({ runRef: "run-1", kind: "discovery", depth: "grouping" })).toThrowError(/bounds/);
  });
});

describe("deep enrichment", () => {
  const deepRun: OnboardRunView = { runRef: "run-1", kind: "discovery", depth: "deep", bounds };

  function deepCollector(items: DiscoveryInventoryItem[]) {
    const { facade: port, recorded } = facade(items);
    const disk = scratch();
    const cloneShallow = vi.fn(async () => gitOk(undefined));
    const collector = new OnboardEvidenceCollector({
      git: {
        version: async () => "2.45.2",
        lsRemote: async () => gitOk([]),
        archiveFile: async () => gitGap<Buffer>("not_found", "absent"),
        credential: async () => gitGap<{ username: string; password: string }>("credential_unavailable", "sign in"),
        cloneShallow: cloneShallow as never,
        cloneMirror: async () => gitOk(undefined),
        pushMirror: async () => gitOk(undefined),
      },
      rawFiles: { read: async () => gitGap<Buffer>("not_found", "absent") },
      scratch: disk as never,
      facade: port,
      resolveRemote: item => ({ url: item.url }),
    });
    return { collector, recorded, disk, cloneShallow };
  }

  it("clones only the accepted System's repositories, at most the allowance, and removes them", async () => {
    const items = inventory(10);
    const { collector, recorded, disk, cloneShallow } = deepCollector(items);

    const outcome = await collector.runEnrichment(deepRun, {
      systemRef: "system:default/payments",
      allowance: 2,
      canonicalKeys: items.slice(0, 5).map(item => item.canonicalKey),
    });

    expect(outcome).toEqual({ cloned: 2, submitted: 2, disposition: "completed" });
    expect(cloneShallow).toHaveBeenCalledTimes(2);
    expect(recorded.enriched).toHaveLength(2);
    expect(disk.live.size).toBe(0);
    expect(disk.releaseClone).toHaveBeenCalledTimes(2);
  });

  it("reports cloning before each clone and extracted on submission", async () => {
    const items = inventory(2);
    const { collector, recorded } = deepCollector(items);

    await collector.runEnrichment(deepRun, { systemRef: "system:default/payments", allowance: 2, canonicalKeys: items.map(item => item.canonicalKey) });

    const forFirst = recorded.progress.filter(entry => entry.canonicalKey === items[0]!.canonicalKey).map(entry => entry.state);
    expect(forFirst).toEqual(["cloning", "extracted"]);
  });

  it("completes immediately with budget_exhausted on an allowance of 0", async () => {
    const { collector, recorded, cloneShallow } = deepCollector(inventory(3));

    const outcome = await collector.runEnrichment(deepRun, { systemRef: "system:default/payments", allowance: 0, canonicalKeys: ["git.example.com/acme/service-0"] });

    expect(outcome).toEqual({ cloned: 0, submitted: 0, disposition: "budget_exhausted" });
    expect(cloneShallow).not.toHaveBeenCalled();
    expect(recorded.progress).toEqual([]);
  });

  it("never exceeds the run-wide maxRepositoriesDeep even when asked to", async () => {
    const items = inventory(10);
    const { collector, cloneShallow } = deepCollector(items);

    await collector.runEnrichment(deepRun, { systemRef: "system:default/payments", allowance: 9, canonicalKeys: items.map(item => item.canonicalKey) });

    expect(cloneShallow).toHaveBeenCalledTimes(bounds.maxRepositoriesDeep);
  });
});

describe("the bounded read list", () => {
  it("spends the descriptor and ownership reads first", () => {
    expect(evidenceCandidates("service", 3).map(candidate => candidate.path)).toEqual(["catalog-info.yaml", ".github/CODEOWNERS", "CODEOWNERS"]);
  });

  it("derives the .csproj spellings from the repository name, having no listing", () => {
    const paths = evidenceCandidates("Payments", 32).map(candidate => candidate.path);
    expect(paths).toContain("Payments.csproj");
    expect(paths).toContain("src/Payments/Payments.csproj");
  });
});

describe("fact extraction stays facts", () => {
  it("lifts handles, manifests, layout and descriptor and nothing else", () => {
    const facts = extractFacts([
      { candidate: { path: ".github/CODEOWNERS", kind: "codeowners", family: "codeowners" }, body: CODEOWNERS },
      { candidate: { path: "package.json", kind: "project-manifest", family: "manifest" }, body: PACKAGE_JSON },
      { candidate: { path: "catalog-info.yaml", kind: "catalog-descriptor", family: "descriptor" }, body: Buffer.from("metadata:\n  name: payments-api\nspec:\n  system: payments\n") },
      { candidate: { path: ".goreleaser.yml", kind: "release-signal", family: "release" }, body: Buffer.from("builds: []\n") },
    ]);

    expect(facts.codeowners?.handles).toEqual(["@acme/platform", "@acme/sre", "@acme/writers"]);
    expect(facts.manifests).toEqual([{ kind: "npm", name: "@acme/service", dependencies: ["left"] }]);
    expect(facts.layout).toEqual({ monorepo: true, workspaces: ["packages/*"] });
    expect(facts.descriptor).toEqual({ systemName: "payments", componentName: "payments-api" });
    expect(facts.release).toEqual([{ kind: "goreleaser" }]);
  });

  it("keeps CODEOWNERS path patterns out of the facts", () => {
    expect(parseCodeowners("/services/api @acme/api\n")).toEqual(["@acme/api"]);
    expect(parseCodeowners("*  @acme/platform  @acme/sre\n")).toEqual(["@acme/platform", "@acme/sre"]);
  });

  it("contributes nothing from a file it cannot parse", () => {
    expect(parseDescriptor("not: a descriptor we understand\n")).toBeNull();
    expect(extractFacts([{ candidate: { path: "package.json", kind: "project-manifest", family: "manifest" }, body: Buffer.from("{ broken") }])).toEqual({});
  });
});

describe("which credential reaches which repository", () => {
  const binding = { host: "git.konteks.io", identityFile: "/keys/konteks_ed25519" };

  it("uses the registered key over SSH for managed git", () => {
    expect(resolveRemote({ url: "https://git.konteks.io/acme/api", repoOwner: "acme", repoName: "api" }, binding)).toEqual({
      url: "git@git.konteks.io:acme/api.git",
      identityFile: "/keys/konteks_ed25519",
    });
  });

  it("uses the machine's own git for a customer connector, with no identity injected", () => {
    expect(resolveRemote({ url: "https://github.com/acme/api", repoOwner: "acme", repoName: "api" }, binding)).toEqual({ url: "https://github.com/acme/api.git" });
    expect(resolveRemote({ url: "https://github.com/acme/api", repoOwner: "acme", repoName: "api" }, null)).toEqual({ url: "https://github.com/acme/api.git" });
  });

  it("keeps a provider's own repository path rather than rebuilding owner/name", () => {
    expect(resolveRemote({ url: "https://dev.azure.com/acme/platform/_git/api", repoOwner: "acme", repoName: "api" }, null)).toEqual({
      url: "https://dev.azure.com/acme/platform/_git/api.git",
    });
  });
});
