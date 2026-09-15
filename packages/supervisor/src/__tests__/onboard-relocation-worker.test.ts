import { describe, expect, it, vi } from "vitest";
import type { RepositoryRelocateReportInput } from "@konteks/remote-common";
import { RepositoryRelocationWorker } from "../onboard/relocation-worker.js";
import { refDigest, gitGap, gitOk, type GitRef } from "../onboard/git.js";
import type { OnboardFacade, RelocationPlan } from "../onboard/facade.js";

const SOURCE_REFS: GitRef[] = [
  { ref: "refs/heads/main", sha: "a".repeat(40) },
  { ref: "refs/tags/v1.0.0", sha: "b".repeat(40) },
];

const from = { vcsConnectorId: "managed", provider: "gitea", baseUrl: "https://git.konteks.io", repoOwner: "acme", repoName: "payments" };
const to = { vcsConnectorId: "customer", provider: "gitea", baseUrl: "https://gitea.acme.test", repoOwner: "acme", repoName: "payments" };

/**
 * Core owns the step. The harness advances it exactly where Core would —
 * `freeze` after `propose`, `cutover` after the permit is answered — so the
 * worker's resumption is exercised against the real shape of the sequence.
 */
function core(initial: RelocationPlan["step"], options: { advance?: boolean } = {}) {
  const reports: RepositoryRelocateReportInput[] = [];
  let step: RelocationPlan["step"] = initial;
  let verification: RelocationPlan["verification"];
  const plan = (): RelocationPlan => ({ relocationRef: "relocation-1", step, from, to, ...(verification ? { verification } : {}) });
  const facade: OnboardFacade = {
    runGet: async () => {
      throw new Error("not used");
    },
    inventoryList: async () => ({ items: [] }),
    evidenceSubmit: async () => undefined,
    enrichmentProgress: async () => undefined,
    enrichmentSubmit: async () => undefined,
    relocationStatus: async () => plan(),
    relocationReport: async report => {
      reports.push(report);
      if (report.error) return plan();
      if (options.advance !== false) {
        if (report.step === "propose") step = "sync";
        if (report.step === "sync") step = "verify";
        if (report.step === "verify") {
          step = "cutover";
          verification = report.verification;
        }
        if (report.step === "cutover") step = "settle";
      }
      return plan();
    },
  };
  return { facade, reports, current: () => step };
}

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
    readCloned: vi.fn(async () => null),
    live: clones,
  };
}

function git(options: { target?: GitRef[]; pushFails?: boolean; sourceUnreadable?: boolean } = {}) {
  let target = options.target ?? [];
  const pushMirror = vi.fn(async () => {
    if (options.pushFails) return gitGap<void>("unavailable", "the push was interrupted");
    target = [...SOURCE_REFS];
    return gitOk(undefined);
  });
  const cloneMirror = vi.fn(async () => gitOk(undefined));
  return {
    api: {
      version: async () => "2.45.2",
      lsRemote: vi.fn(async (remote: { url: string }) => {
        if (remote.url.includes("git.konteks.io")) {
          return options.sourceUnreadable ? gitGap<GitRef[]>("credential_unavailable", "sign in to this provider") : gitOk(SOURCE_REFS);
        }
        return gitOk(target);
      }),
      archiveFile: async () => gitGap<Buffer>("not_found", "absent"),
      credential: async () => gitGap<{ username: string; password: string }>("credential_unavailable", "sign in"),
      cloneShallow: async () => gitOk(undefined),
      cloneMirror,
      pushMirror,
    },
    cloneMirror,
    pushMirror,
    targetRefs: () => target,
  };
}

function worker(facade: OnboardFacade, access: ReturnType<typeof git>, disk = scratch()) {
  return {
    disk,
    worker: new RepositoryRelocationWorker({
      git: access.api as never,
      scratch: disk as never,
      facade,
      managedBinding: () => null,
      now: () => "2026-09-14T00:00:00.000Z",
      wait: async () => undefined,
      pollIntervalMs: 0,
      maxPolls: 4,
    }),
  };
}

describe("the relocation sequence", () => {
  it("proposes, syncs, verifies, cuts over and settles with equal digests", async () => {
    const { facade, reports } = core("propose");
    const access = git();
    const { worker: subject, disk } = worker(facade, access);

    const outcome = await subject.run("relocation-1");

    expect(reports.map(report => report.step)).toEqual(["propose", "sync", "verify", "cutover", "settle"]);
    const verify = reports.find(report => report.step === "verify")!;
    expect(verify.verification).toEqual({ refs: 2, headShaByRef: refDigest(SOURCE_REFS), verifiedAt: "2026-09-14T00:00:00.000Z" });
    expect(outcome).toEqual({ step: "settle", disposition: "settled" });
    // The scratch is removed at settle and nowhere earlier.
    expect(disk.live.size).toBe(0);
  });

  it("refuses a target that is not empty, because some providers pre-create a README", async () => {
    const { facade, reports } = core("propose");
    const access = git({ target: [{ ref: "refs/heads/main", sha: "c".repeat(40) }] });
    const { worker: subject } = worker(facade, access);

    const outcome = await subject.run("relocation-1");

    expect(outcome.disposition).toBe("refused");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ step: "propose", error: { code: "relocation_target_not_empty" } });
    expect(access.pushMirror).not.toHaveBeenCalled();
  });

  it("reports a side it cannot read as credential_unavailable before anything is frozen", async () => {
    const { facade, reports } = core("propose");
    const access = git({ sourceUnreadable: true });
    const { worker: subject } = worker(facade, access);

    const outcome = await subject.run("relocation-1");

    expect(outcome).toMatchObject({ step: "propose", disposition: "refused", gap: { code: "credential_unavailable" } });
    expect(reports[0]).toMatchObject({ step: "propose", error: { code: "credential_unavailable", message: "sign in to this provider" } });
    expect(access.cloneMirror).not.toHaveBeenCalled();
  });

  it("keeps the scratch when a mirror push fails, so the retry pushes rather than re-clones", async () => {
    const { facade, reports } = core("sync");
    const access = git({ pushFails: true });
    const { worker: subject, disk } = worker(facade, access);

    const outcome = await subject.run("relocation-1");

    expect(outcome.disposition).toBe("refused");
    expect(reports[0]).toMatchObject({ step: "sync", error: { code: "relocation_mirror_push_failed" } });
    expect(disk.live.has("relocation-relocation-1")).toBe(true);
    expect(disk.releaseClone).not.toHaveBeenCalled();
  });
});

describe("a worker that died between sync and verify", () => {
  it("resumes from Core's step, re-runs the idempotent push and verifies without duplicate refs", async () => {
    // The first worker pushed and died before reporting verify, so Core is
    // still at `sync` when the replacement claims the assignment.
    const { facade, reports } = core("sync");
    const access = git();
    const { worker: subject, disk } = worker(facade, access);

    const outcome = await subject.run("relocation-1");

    expect(reports.map(report => report.step)).toEqual(["sync", "verify", "cutover", "settle"]);
    expect(outcome.disposition).toBe("settled");
    // A mirror push converges: the target carries exactly the source's refs.
    expect(access.targetRefs()).toHaveLength(SOURCE_REFS.length);
    expect(refDigest(access.targetRefs())).toBe(refDigest(SOURCE_REFS));
    expect(disk.live.size).toBe(0);
  });

  it("re-uses an existing mirror instead of cloning the source a second time", async () => {
    const { facade } = core("sync");
    const access = git();
    const disk = scratch();
    disk.live.add("relocation-relocation-1");
    const { worker: subject } = worker(facade, access, disk);

    await subject.run("relocation-1");

    expect(access.cloneMirror).not.toHaveBeenCalled();
    expect(access.pushMirror).toHaveBeenCalledTimes(1);
  });
});

describe("verification", () => {
  it("re-runs sync once on a mismatch, then fails open to the person", async () => {
    const { facade, reports } = core("sync");
    const access = git();
    // The push never actually lands, so the two sides can never agree.
    access.api.pushMirror = vi.fn(async () => gitOk(undefined)) as never;
    const { worker: subject } = worker(facade, access);

    const outcome = await subject.run("relocation-1");

    expect(outcome).toMatchObject({ step: "verify", disposition: "refused" });
    expect(reports.filter(report => report.step === "sync")).toHaveLength(2);
    expect(reports.some(report => report.step === "cutover")).toBe(false);
  });

  it("refuses a cutover whose target diverged after it was verified", async () => {
    const { facade, reports } = core("cutover", { advance: false });
    const access = git({ target: [{ ref: "refs/heads/main", sha: "d".repeat(40) }] });
    const { worker: subject } = worker(facade, access);

    // Core recorded the verification the permit was answered against.
    const status = facade.relocationStatus;
    facade.relocationStatus = async () => ({
      ...(await status("relocation-1")),
      verification: { refs: 2, headShaByRef: refDigest(SOURCE_REFS), verifiedAt: "2026-09-14T00:00:00.000Z" },
    });

    const outcome = await subject.run("relocation-1");

    expect(outcome).toMatchObject({ step: "cutover", disposition: "refused" });
    expect(reports[0]).toMatchObject({ step: "cutover", error: { code: "relocation_target_diverged" } });
  });
});

describe("waiting on Core", () => {
  it("releases the worker rather than pinning the runtime when nobody answers the permit", async () => {
    const { facade, reports } = core("sync", { advance: false });
    const access = git();
    const { worker: subject } = worker(facade, access);

    const outcome = await subject.run("relocation-1");

    // sync and verify were reported; the cutover permit never arrived.
    expect(reports.map(report => report.step)).toEqual(["sync", "verify"]);
    expect(outcome).toEqual({ step: "sync", disposition: "awaiting_core" });
  });
});
