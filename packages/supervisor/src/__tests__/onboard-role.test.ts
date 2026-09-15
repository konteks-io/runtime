import { describe, expect, it, vi } from "vitest";
import type { ConnectedAgentView } from "@konteks/remote-common";
import {
  ONBOARD_EVIDENCE_CAPABILITY,
  ONBOARD_RELOCATION_CAPABILITY,
  agentSatisfiesRole,
  deriveAdvertisedRoles,
  onboardCapabilities,
  placedAgentReady,
} from "../inventory/roles.js";
import { LocalGit, classifyGitFailure, parseLsRemote, refDigest } from "../onboard/git.js";

const ready: ConnectedAgentView = {
  agentId: "codex",
  readiness: "ready",
  connectionState: "ready",
  authMode: "agent_local_subscription",
  accountScope: "personal",
} as unknown as ConnectedAgentView;

const bindings = [{ role: "onboard" as const, agentPreference: ["codex"] }];

describe("the onboard role is the machine's git", () => {
  it("advertises both capabilities and the version when git answers", () => {
    expect(onboardCapabilities("2.45.2")).toEqual([
      ONBOARD_EVIDENCE_CAPABILITY,
      ONBOARD_RELOCATION_CAPABILITY,
      "git:2.45.2",
    ]);
    expect(deriveAdvertisedRoles(bindings, [ready], { browserToolAvailable: false, gitVersion: "2.45.2" })).toEqual(["onboard"]);
    expect(placedAgentReady([ready], "codex", "onboard", { browserToolAvailable: false, gitVersion: "2.45.2" })).toBe(true);
  });

  it("advertises neither capability and no role without git on PATH", () => {
    expect(onboardCapabilities(null)).toEqual([]);
    expect(onboardCapabilities("")).toEqual([]);
    // An absent probe is not a licence to claim the role: the runtime is
    // ineligible for both work kinds and Core reports the ordinary reason.
    expect(deriveAdvertisedRoles(bindings, [ready], { browserToolAvailable: true })).toEqual([]);
    expect(deriveAdvertisedRoles(bindings, [ready], { browserToolAvailable: true, gitVersion: null })).toEqual([]);
    expect(placedAgentReady([ready], "codex", "onboard", { browserToolAvailable: true, gitVersion: null })).toBe(false);
  });

  it("still needs a ready agent, because the session's turns run on one", () => {
    const unavailable = { ...ready, readiness: "unavailable" } as ConnectedAgentView;
    expect(agentSatisfiesRole(unavailable, "onboard", { browserToolAvailable: false, gitVersion: "2.45.2" })).toBe(false);
  });

  it("does not disturb the roles that came before it", () => {
    const all = [
      { role: "planner" as const, agentPreference: ["codex"] },
      { role: "generator" as const, agentPreference: ["codex"] },
      { role: "qa" as const, agentPreference: ["codex"] },
      { role: "ops" as const, agentPreference: ["codex"] },
    ];
    expect(deriveAdvertisedRoles(all, [ready], { browserToolAvailable: false, gitVersion: null })).toEqual(["planner", "generator", "qa"]);
  });
});

describe("the git probe", () => {
  const run = (result: { code: number | null; stdout?: string; stderr?: string }) =>
    vi.fn(async () => ({ code: result.code, signal: null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }));

  it("reads the version once per TTL", async () => {
    const runner = run({ code: 0, stdout: "git version 2.45.2\n" });
    let now = 1_000;
    const git = new LocalGit({ run: runner as never, versionTtlMs: 500, now: () => now });
    expect(await git.version()).toBe("2.45.2");
    expect(await git.version()).toBe("2.45.2");
    expect(runner).toHaveBeenCalledTimes(1);
    now += 501;
    expect(await git.version()).toBe("2.45.2");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("answers null when git is not on PATH instead of throwing", async () => {
    const runner = vi.fn(async () => {
      throw new Error("spawn git ENOENT");
    });
    expect(await new LocalGit({ run: runner as never }).version()).toBeNull();
  });
});

describe("git failures are evidence gaps, not exceptions", () => {
  it.each([
    ["fatal: Authentication failed for 'https://example/x.git'", "credential_unavailable"],
    ["fatal: could not read Username for 'https://example': terminal prompts disabled", "credential_unavailable"],
    ["ERROR: Permission denied (publickey).", "credential_unavailable"],
    ["remote: Repository not found.", "not_found"],
    ["fatal: unable to access: Could not resolve host", "unavailable"],
  ] as const)("classifies %s", (stderr, code) => {
    const gap = classifyGitFailure(stderr);
    expect(gap.code).toBe(code);
    expect(gap.remedy.length).toBeGreaterThan(0);
  });
});

describe("ref digests", () => {
  it("is stable across the order two providers enumerate refs in", () => {
    const stdout = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v1\n";
    const refs = parseLsRemote(stdout);
    expect(refs).toHaveLength(2);
    expect(refDigest(refs)).toBe(refDigest([...refs].reverse()));
  });

  it("changes when a ref moves", () => {
    const before = [{ ref: "refs/heads/main", sha: "a".repeat(40) }];
    const after = [{ ref: "refs/heads/main", sha: "b".repeat(40) }];
    expect(refDigest(before)).not.toBe(refDigest(after));
  });
});
