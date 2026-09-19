import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initiativeTitle, isNo, isYes, onboardFailureStep, runOnboardStep } from "../native/onboard.js";
import { RemoteInstanceError } from "@konteks/remote-common";
import { readOnboardState, writeOnboardState } from "../native/onboard-state.js";
import { OWNER_ACCESS_REVOKED, writeOwnerToken } from "../native/owner-api.js";
import { createOutput } from "../output.js";

/**
 * The conversation an agent relays (onboarding-simplified OS5–OS16).
 *
 * These drive the state machine the way the agent does: one invocation per
 * step, with the person's answer arriving as an argument on the next one.
 */

const output = () => createOutput({ json: true, stdout: { write: () => true } as never, stderr: { write: () => true } as never });

describe("onboard", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "konteks-onboard-"));
    await writeOwnerToken(join(root, "supervisor"), {
      token: "owner-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      userRef: "user:default/ada",
      tenantId: "acme",
      instanceId: "instance-1",
    }).catch(() => undefined);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  // A connected machine's service answers; the tests that care about it say so
  // themselves, and the rest should not have to stand up a supervisor.
  const readyService = async () => ({ administrativeStatus: "active", roles: ["assistant", "onboard"] });
  const step = (extra: Parameters<typeof runOnboardStep>[0]["deps"] = {}, answer?: string) =>
    runOnboardStep({
      root,
      output: output(),
      coreUrl: "https://core.test",
      siteUrl: "https://app.test",
      ...(answer !== undefined ? { answer } : {}),
      deps: { waitForReady: readyService, ...extra },
    });

  it("asks for the email in its very first response on a machine that is not connected", async () => {
    const { SupervisorStore } = await import("@konteks/remote-supervisor");
    vi.spyOn(SupervisorStore.prototype, "identity").mockResolvedValue(null as never);
    const first = await step({});
    expect(first.run).toBeUndefined();
    expect(first.ask).toMatchObject({ kind: "email" });
    expect(await readOnboardState(root)).toMatchObject({ step: "email" });
    vi.restoreAllMocks();
  });

  it("asks only for the repository once a machine is already connected", async () => {
    await writeOnboardState(root, {
      step: "inspect",
      instanceId: "instance-1",
      tenantId: "acme",
    } as never);
    const result = await step({
      inspect: async () => ({
        path: "/tmp/acme-shop",
        name: "acme-shop",
        remoteUrl: "https://github.com/acme/shop",
        remoteReachable: true,
        currentBranch: "main",
        defaultBranch: "main",
      }),
    });
    expect(result.step).toBe("inspect");
    expect(result.note).toContain("acme-shop");
    expect(result.run?.argv[0]).toBe("konteks-remote");
    expect(await readOnboardState(root)).toMatchObject({
      step: "system",
      repositoryKind: "existing",
      repositoryName: "acme-shop",
    });
  });

  it("offers managed git when the remote cannot be reached", async () => {
    await writeOnboardState(root, { step: "inspect" } as never);
    await step({
      inspect: async () => ({
        path: "/tmp/solo",
        name: "solo",
        remoteUrl: "git@github.com:private/solo.git",
        remoteReachable: false,
        currentBranch: "trunk",
        defaultBranch: "trunk",
      }),
    });
    expect(await readOnboardState(root)).toMatchObject({ repositoryKind: "managed" });
  });

  it("greets a new conversation on a finished machine instead of replaying the old summary", async () => {
    // W1-A8: the person pastes the block into a new agent in the same folder.
    // The old closing summary came back as if setup had just happened, and the
    // new agent told the person to check what "they" had chosen.
    const { SupervisorStore } = await import("@konteks/remote-supervisor");
    vi.spyOn(SupervisorStore.prototype, "identity").mockResolvedValue({ instanceId: "instance-1", workspaceId: "konteks-2" } as never);
    await writeOnboardState(root, {
      step: "done",
      tenantId: "konteks-2",
      ownerEmail: "hello@konteks.io",
      repositoryName: "konteks-onboard-app",
      repositoryPath: "/tmp/projects/konteks-onboard-app",
      repositoryKind: "managed",
      systemEntityRef: "system:default/konteks-2-onboard-app",
      initiativeId: "init-1",
      initiativeTitle: "A simple site where people can book a table at my restaurant",
    } as never);
    const greeting = await step({});
    expect(greeting.ask).toBeUndefined();
    expect(greeting.note).toContain("already connected to konteks-2 as hello@konteks.io");
    expect(greeting.run).toEqual({ argv: ["konteks-remote", "onboard", "--json"] });

    const here = {
      inspect: async () => ({ path: "/tmp/projects/konteks-onboard-app", name: "konteks-onboard-app", remoteUrl: "ssh://git@git.test/konteks-2/konteks-onboard-app.git", remoteReachable: true, currentBranch: "main", defaultBranch: "main" }),
    };
    const settled = await step(here);
    expect(settled.done?.summary).toContain("already your System");
    expect(settled.done?.summary).not.toContain("is working on it here");
    expect(await readOnboardState(root)).toMatchObject({ step: "done" });

    // And the next new conversation is greeted the same way.
    const again = await step({});
    expect(again.note).toContain("already connected");
    vi.restoreAllMocks();
  });

  it("takes a yes or a no the way people actually write them", () => {
    // Passes 20 and 21 refused "Yes.", "Yes, please." and "Yes, try it
    // again." — the agent had to rewrite the person's answer to get through.
    for (const said of ["yes", "Yes.", "Yes, please.", "yes, try it again", "Sure!", "OK", "go ahead", "Yep - push it"]) {
      expect(isYes(said), said).toBe(true);
    }
    for (const said of ["no", "No.", "No thanks", "not now", "Nope, later"]) {
      expect(isNo(said), said).toBe(true);
      expect(isYes(said), said).toBe(false);
    }
    // A yes that takes itself back is not a yes, and an answer that is
    // neither is asked again rather than guessed.
    for (const said of ["yes, but not now", "please don't", "maybe", "acme-shop"]) {
      expect(isYes(said), said).toBe(false);
    }
  });

  it("asks a yes/no about the first System and accepts no without registering", async () => {
    await writeOnboardState(root, {
      step: "system",
      repositoryName: "acme-shop",
      repositoryKind: "existing",
      repositoryPath: "/tmp/acme-shop",
      defaultBranch: "main",
      remoteUrl: "https://github.com/acme/shop",
    } as never);
    const here = {
      inspect: async () => ({ path: "/tmp/acme-shop", name: "acme-shop", remoteUrl: "https://github.com/acme/shop", remoteReachable: true, currentBranch: "main", defaultBranch: "main" }),
    };
    const question = await step(here);
    expect(question.ask).toMatchObject({ kind: "confirm" });
    expect(question.ask?.question).toContain("acme-shop");

    const declined = await step(here, "no");
    expect(declined.note).toContain("Leaving the catalog");
    expect(await readOnboardState(root)).toMatchObject({ step: "first_task" });
  });

  it("registers the first System and moves to the push step for managed git", async () => {
    await writeOnboardState(root, {
      step: "system",
      repositoryName: "solo",
      repositoryKind: "managed",
      repositoryPath: "/tmp/solo",
      defaultBranch: "trunk",
      instanceId: "instance-1",
    } as never);
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          systemId: "sys-1",
          systemEntityRef: "system:default/acme-solo",
          componentEntityRef: "component:default/acme-solo",
          repository: { kind: "managed", remoteUrl: "https://git.konteks.test/acme/solo", defaultBranch: "trunk" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await step({ fetchFn: fetchFn as never }, "yes");
    expect(result.note).toContain("is now a System");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://core.test/api/app/catalog/systems/first");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer owner-token");
    expect(await readOnboardState(root)).toMatchObject({
      step: "push",
      systemId: "sys-1",
      managedRemoteUrl: "https://git.konteks.test/acme/solo",
    });
  });

  it("stops at the next step with why, once this machine's access was revoked in Settings (W1-X3)", async () => {
    await writeOnboardState(root, {
      step: "system",
      repositoryName: "solo",
      repositoryKind: "managed",
      repositoryPath: "/tmp/solo",
      defaultBranch: "trunk",
      instanceId: "instance-1",
    } as never);
    const refusal = (body: object) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status: 401, headers: { "content-type": "application/json" } }));
    const error = await step({ fetchFn: refusal({ code: "enrollment_invalid", message: "revoked" }) as never }, "yes").catch((e: unknown) => e);
    expect((error as Error).message).toBe(OWNER_ACCESS_REVOKED);
    const stopped = await onboardFailureStep({ root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test" }, error);
    expect(stopped.done?.summary).toContain("revoked in Settings");
    expect(stopped.ask).toBeUndefined();
    expect(await readOnboardState(root)).toMatchObject({ step: "system" });

    const other = await step({ fetchFn: refusal({ error: { name: "AuthenticationError" } }) as never }, "yes").catch((e: unknown) => e);
    expect((other as Error).message).toBe("This machine's Konteks access was refused.");
  });

  it("pushes only the branch the person is on, and only after a yes", async () => {
    await writeOnboardState(root, {
      step: "push",
      repositoryPath: "/tmp/solo",
      managedRemoteUrl: "https://git.konteks.test/acme/solo",
      defaultBranch: "trunk",
    } as never);
    const push = vi.fn(async () => ({ pushed: true, message: "Pushed trunk to Konteks managed git." }));
    const declined = await step({ push: push as never }, "not now");
    expect(push).not.toHaveBeenCalled();
    expect(declined.note).toContain("Nothing was pushed");

    await writeOnboardState(root, {
      step: "push",
      repositoryPath: "/tmp/solo",
      managedRemoteUrl: "https://git.konteks.test/acme/solo",
      defaultBranch: "trunk",
    } as never);
    const announced = await step({ push: push as never }, "yes");
    expect(push).not.toHaveBeenCalled();
    expect(announced.note).toContain("Pushing trunk");
    expect(announced.run?.argv).toEqual(["konteks-remote", "onboard", "--json"]);
    const accepted = await step({ push: push as never });
    expect(push).toHaveBeenCalledWith({
      repositoryPath: "/tmp/solo",
      remoteUrl: "https://git.konteks.test/acme/solo",
      branch: "trunk",
    });
    expect(accepted.note).toContain("Pushed trunk");
    expect(accepted.note).toContain("now lives on Konteks managed git");
    expect(await readOnboardState(root)).toMatchObject({ step: "first_task" });
  });

  it("offers a plain project folder as the first System on managed git", async () => {
    await writeOnboardState(root, { step: "inspect" } as never);
    const result = await runOnboardStep({
      root,
      output: output(),
      coreUrl: "https://core.test",
      siteUrl: "https://app.test",
      cwd: "/tmp/projects/konteks-onboard-app",
      deps: {
        waitForReady: async () => ({ administrativeStatus: "active", roles: ["assistant", "onboard"] }),
        inspect: async () => ({ path: null, name: "konteks-onboard-app", remoteUrl: null, remoteReachable: false, currentBranch: null, defaultBranch: "main" }),
      },
    });
    expect(result.note).toContain("not a git repository yet");
    expect(result.note).not.toContain("no first System");
    expect(await readOnboardState(root)).toMatchObject({
      step: "system",
      repositoryKind: "managed",
      repositoryNeedsInit: true,
      repositoryName: "konteks-onboard-app",
      repositoryPath: "/tmp/projects/konteks-onboard-app",
      defaultBranch: "main",
    });
  });

  it("never offers a home folder as a System", async () => {
    const { homedir } = await import("node:os");
    await writeOnboardState(root, { step: "inspect" } as never);
    const result = await runOnboardStep({
      root,
      output: output(),
      coreUrl: "https://core.test",
      siteUrl: "https://app.test",
      cwd: homedir(),
      deps: {
        waitForReady: async () => ({ administrativeStatus: "active", roles: ["assistant", "onboard"] }),
        inspect: async () => ({ path: null, name: "me", remoteUrl: null, remoteReachable: false, currentBranch: null, defaultBranch: "main" }),
      },
    });
    expect(result.note).toContain("home folder");
    expect(await readOnboardState(root)).toMatchObject({ step: "first_task" });
  });

  it("asks again for the step that was skipped instead of going on without the service", async () => {
    // The step before this one told the agent to run `konteks-remote start`.
    // When nothing answers, that did not happen, and going on regardless is
    // how the omission surfaced two questions later, during the push.
    await writeOnboardState(root, { step: "inspect" } as never);
    let inspected = false;
    const result = await runOnboardStep({
      root,
      output: output(),
      coreUrl: "https://core.test",
      siteUrl: "https://app.test",
      cwd: "/tmp/projects/konteks-onboard-app",
      deps: {
        waitForReady: async () => null,
        inspect: async () => {
          inspected = true;
          return { path: null, name: "konteks-onboard-app", remoteUrl: null, remoteReachable: false, currentBranch: null, defaultBranch: "main" };
        },
      },
    });
    expect(result.run).toEqual({ argv: ["konteks-remote", "start"] });
    expect(result.note).toContain("not running yet");
    expect(inspected).toBe(false);
    expect(await readOnboardState(root)).toMatchObject({ step: "inspect" });
  });

  it("says a service that is still starting is starting, rather than asking for start again", async () => {
    // `konteks-remote start` returns as soon as the process is up, but the
    // service opens for work about a minute later. Asking for `start` again in
    // that window is a loop on something that is already coming up.
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(
      join(root, "native-runtime.json"),
      JSON.stringify({ schemaVersion: 1, deploymentKind: "native_connector", instanceId: "instance-1", workspaceId: "konteks-2", releaseId: "release-1", manifestDigest: "d", bundleVersion: "0.4.1", coreUrl: "https://core.test", relayUrl: "wss://core.test/relay", agents: ["claude-code"], controlPort: 41800 }),
    );
    await chmod(join(root, "native-runtime.json"), 0o600);
    await writeOnboardState(root, { step: "inspect" } as never);
    const result = await runOnboardStep({
      root,
      output: output(),
      coreUrl: "https://core.test",
      siteUrl: "https://app.test",
      cwd: "/tmp/projects/konteks-onboard-app",
      deps: { waitForReady: async () => null, inspect: async () => { throw new Error("must not inspect"); } },
    });
    expect(result.run).toEqual({ argv: ["konteks-remote", "onboard", "--json"] });
    expect(result.note).toContain("still starting");
    expect(await readOnboardState(root)).toMatchObject({ step: "inspect" });
  });

  it("makes a plain folder a repository with one empty commit before pushing, and only after a yes", async () => {
    await writeOnboardState(root, {
      step: "push",
      repositoryName: "konteks-onboard-app",
      repositoryPath: "/tmp/projects/konteks-onboard-app",
      repositoryNeedsInit: true,
      repositoryKind: "managed",
      managedRemoteUrl: "https://git.konteks.test/acme/app",
      defaultBranch: "main",
      systemId: "sys-1",
      ownerEmail: "hello@konteks.io",
    } as never);
    const initialize = vi.fn(async () => ({ ok: true, message: "konteks-onboard-app is now a git repository on main." }));
    const push = vi.fn(async () => ({ pushed: true, message: "Pushed main to Konteks managed git." }));
    const question = await step({ initialize, push: push as never });
    expect(question.ask?.question).toContain("empty first commit");
    expect(question.ask?.question).toContain("no files are added");
    await step({ initialize, push: push as never }, "yes");
    expect(initialize).not.toHaveBeenCalled();
    const pushed = await step({ initialize, push: push as never });
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      path: "/tmp/projects/konteks-onboard-app",
      branch: "main",
      authorName: "hello",
      authorEmail: "hello@konteks.io",
    }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(pushed.note).toContain("https://app.test/systems/sys-1");
  });

  it("pushes to managed git over SSH with the runtime's own registered key", async () => {
    await writeOnboardState(root, {
      step: "pushing",
      repositoryName: "konteks-onboard-app",
      repositoryPath: "/tmp/projects/konteks-onboard-app",
      managedRemoteUrl: "https://git.konteks.test/konteks-2/konteks-onboard-app",
      managedSshUrl: "ssh://git@git.konteks.test:2222/konteks-2/konteks-onboard-app.git",
      defaultBranch: "main",
      systemId: "sys-1",
    } as never);
    const registerGitKey = vi.fn(async () => ({ identityFile: "/home/me/Library/Application Support/konteks-remote/git/id_ed25519", user: "git" }));
    const push = vi.fn(async () => ({ pushed: true, message: "Pushed main to Konteks managed git." }));
    const result = await step({ registerGitKey, push: push as never });
    expect(registerGitKey).toHaveBeenCalledWith(root);
    expect(push).toHaveBeenCalledWith({
      repositoryPath: "/tmp/projects/konteks-onboard-app",
      remoteUrl: "ssh://git@git.konteks.test:2222/konteks-2/konteks-onboard-app.git",
      branch: "main",
      sshCommand: "ssh -i '/home/me/Library/Application Support/konteks-remote/git/id_ed25519' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new",
    });
    expect(result.note).toContain("now lives on Konteks managed git");
  });

  it("says plainly when the runtime cannot register its git key, and pushes nothing", async () => {
    await writeOnboardState(root, {
      step: "pushing",
      repositoryName: "solo",
      repositoryPath: "/tmp/solo",
      managedRemoteUrl: "https://git.konteks.test/acme/solo",
      managedSshUrl: "ssh://git@git.konteks.test:2222/acme/solo.git",
      defaultBranch: "main",
    } as never);
    const push = vi.fn();
    const registerGitKey = vi.fn(async () => { throw new Error("The Konteks service on this machine is not running."); });
    const result = await step({ registerGitKey, push: push as never });
    expect(push).not.toHaveBeenCalled();
    expect(result.note).toContain("could not register its key");
    expect(result.note).toContain("not running");
    expect(result.ask).toMatchObject({ kind: "confirm" });
    expect(await readOnboardState(root)).toMatchObject({ step: "push" });
  });

  it("joins the Konteks repository's own first commit instead of pushing an unrelated one", async () => {
    await writeOnboardState(root, {
      step: "pushing",
      repositoryName: "konteks-onboard-app",
      repositoryPath: "/tmp/projects/konteks-onboard-app",
      repositoryNeedsInit: true,
      repositoryKind: "managed",
      managedRemoteUrl: "https://git.konteks.test/konteks-2/konteks-onboard-app",
      managedSshUrl: "ssh://git@git.konteks.test:2222/konteks-2/konteks-onboard-app.git",
      defaultBranch: "main",
      systemId: "sys-1",
    } as never);
    const registerGitKey = vi.fn(async () => ({ identityFile: "/keys/id_ed25519" }));
    const initialize = vi.fn(async () => ({ ok: true, adopted: true, message: "konteks-onboard-app is now a git repository on main, tracking the Konteks repository, which already had its first commit." }));
    const push = vi.fn();
    const result = await step({ registerGitKey, initialize, push: push as never });
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      remote: { url: "ssh://git@git.konteks.test:2222/konteks-2/konteks-onboard-app.git", sshCommand: expect.stringContaining("/keys/id_ed25519") },
    }));
    expect(push).not.toHaveBeenCalled();
    expect(result.note).toContain("tracking the Konteks repository");
    expect(result.note).toContain("https://app.test/systems/sys-1");
    expect(await readOnboardState(root)).toMatchObject({ step: "first_task" });
  });

  it("re-asks the push in plain words when it does not go through", async () => {
    await writeOnboardState(root, {
      step: "pushing",
      repositoryName: "solo",
      repositoryPath: "/tmp/solo",
      managedRemoteUrl: "https://git.konteks.test/acme/solo",
      defaultBranch: "main",
    } as never);
    const push = vi.fn(async () => ({ pushed: false, message: "The push to Konteks managed git did not go through (git said: denied)." }));
    const result = await step({ push: push as never });
    expect(result.note).toContain("did not go through");
    expect(result.note).not.toMatch(/Run: git/);
    expect(result.ask).toMatchObject({ kind: "confirm" });
    expect(await readOnboardState(root)).toMatchObject({ step: "push" });
  });

  it("makes this machine's agents the workspace's default before the first initiative", async () => {
    await writeOnboardState(root, { step: "agents", systemId: "sys-1", firstTask: "Book a table" } as never);
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/execution-profiles") && init.method === "GET") {
        return new Response(JSON.stringify({ profiles: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/agent-setup/capabilities")) {
        return new Response(JSON.stringify({
          roles: {
            planner: { recommendedOptionId: "native_a", options: [{ optionId: "native_a", runtimeId: "claude-code", providerId: "anthropic", modelId: "claude-sonnet-5", availability: "available" }] },
            executor: { recommendedOptionId: "native_b", options: [{ optionId: "native_b", runtimeId: "claude-code", providerId: "anthropic", modelId: "claude-opus-5", availability: "available" }] },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/execution-profiles") && init.method === "POST") {
        return new Response(JSON.stringify({ profile: { id: "profile-1" } }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ revision: { revision: 1 } }), { status: 201, headers: { "content-type": "application/json" } });
    });

    const result = await step({ fetchFn: fetchFn as never });

    const revision = calls.find(call => call.url.endsWith("/revisions"))!;
    expect(revision.body).toEqual({
      configuration: {
        planner: { runtimeId: "claude-code", agentId: "claude-code", provider: "anthropic", model: "claude-sonnet-5", authMode: "managed_local_auth" },
        executor: { runtimeId: "claude-code", agentId: "claude-code", provider: "anthropic", model: "claude-opus-5", authMode: "managed_local_auth" },
      },
      makeDefault: true,
    });
    expect(result.note).toContain("agents will run the work");
    expect(await readOnboardState(root)).toMatchObject({ step: "initiative" });
  });

  it("leaves a workspace that already chose its agents alone", async () => {
    await writeOnboardState(root, { step: "agents", systemId: "sys-1", firstTask: "Book a table" } as never);
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ profiles: [{ id: "profile-9" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await step({ fetchFn: fetchFn as never });
    expect(urls).toEqual(["https://core.test/api/app/execution-profiles"]);
    expect(await readOnboardState(root)).toMatchObject({ step: "initiative" });
  });

  it("waits for the machine to say what its agents can run, then goes on without it", async () => {
    await writeOnboardState(root, { step: "agents", systemId: "sys-1", firstTask: "Book a table" } as never);
    const fetchFn = vi.fn(async (url: string) =>
      url.endsWith("/execution-profiles")
        ? new Response(JSON.stringify({ profiles: [] }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ roles: { planner: { options: [] }, executor: { options: [] } } }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const waiting = await step({ fetchFn: fetchFn as never, agentsWaitMs: 1 });
    expect(waiting.note).toContain("still learning what this machine's agents can do");
    expect(await readOnboardState(root)).toMatchObject({ step: "agents", agentsWaited: 1 });

    await writeOnboardState(root, { ...(await readOnboardState(root))!, agentsWaited: 9 } as never);
    const givenUp = await step({ fetchFn: fetchFn as never, agentsWaitMs: 1 });
    expect(givenUp.note).toContain("has not told Konteks what its agents can run yet");
    expect(await readOnboardState(root)).toMatchObject({ step: "initiative" });
  });

  it("creates the first initiative from the person's sentence and sends it as the planning session's first turn", async () => {
    await writeOnboardState(root, {
      step: "first_task",
      systemId: "sys-1",
      repositoryName: "konteks-onboard-app",
      instanceId: "instance-1",
      tenantId: "acme",
    } as never);
    const sentence = "A simple site where people book a table at our restaurant. It should send a confirmation email.";
    const fetchFn = vi.fn();
    const announced = await step({ fetchFn: fetchFn as never }, sentence);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(announced.note).toContain("Setting up your first initiative");
    expect(announced.note).toContain("A simple site where people book a table at our restaurant");
    expect(await readOnboardState(root)).toMatchObject({ step: "agents" });
    // The workspace's agents are set up first; this covers the initiative itself.
    await writeOnboardState(root, { ...(await readOnboardState(root))!, step: "initiative" } as never);

    const calls: Array<{ url: string; body: unknown }> = [];
    const created = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const body = url.endsWith("/initiatives")
        ? { initiative: { id: "init-7", title: "A simple site where people book a table at our restaurant", setup: { state: "ready" } }, reconciliation: "recorded", pmSessionId: "session-9", retrySetup: false }
        : { id: "turn-1" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await step({ fetchFn: created as never });
    expect(calls[0]!.url).toBe("https://core.test/api/collaboration/initiatives");
    expect(calls[0]!.body).toEqual({ systemId: "sys-1", title: "A simple site where people book a table at our restaurant" });
    expect(calls[1]!.url).toBe("https://core.test/api/app/sessions/session-9/messages");
    expect(calls[1]!.body).toEqual({ message: sentence });
    expect(calls).toHaveLength(2);
    expect(result.note).toContain("https://app.test/work/init-7");
    expect(result.note).not.toContain("/sessions/");
    expect(await readOnboardState(root)).toMatchObject({ step: "done", initiativeId: "init-7", initiativeUrl: "https://app.test/work/init-7" });
  });

  it("never creates a second initiative when the first turn has to be retried", async () => {
    await writeOnboardState(root, {
      step: "initiative",
      systemId: "sys-1",
      firstTask: "Book a table",
      initiativeId: "init-7",
      initiativeTitle: "Book a table",
      pmSessionId: "session-9",
    } as never);
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    await step({ fetchFn: fetchFn as never });
    expect(urls).toEqual(["https://core.test/api/app/sessions/session-9/messages"]);
  });

  it("points at Retry setup on the initiative when its planning session could not be opened", async () => {
    await writeOnboardState(root, { step: "initiative", systemId: "sys-1", firstTask: "Book a table" } as never);
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ initiative: { id: "init-8", title: "Book a table" }, retrySetup: true, spawnFailure: { code: "reported", message: "No runtime is available" } }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const result = await step({ fetchFn: fetchFn as never });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.note).toContain("Retry setup");
    expect(result.note).toContain("No runtime is available");
    expect(result.note).toContain("https://app.test/work/init-8");
  });

  it("names an initiative from the first sentence, at a title's length", () => {
    expect(initiativeTitle("Add a coupon code to checkout.")).toBe("Add a coupon code to checkout");
    const long = initiativeTitle("I want a very small booking site for my cafe where regulars can reserve the window table and get a reminder the day before.");
    expect(long.length).toBeLessThanOrEqual(81);
    expect(long.endsWith("…")).toBe(true);
  });

  it("says a failure inside the protocol and asks the same question again", async () => {
    await writeOnboardState(root, { step: "code", intentRef: "intent-1", emailMasked: "h••••@konteks.io" } as never);
    const result = await onboardFailureStep(
      { root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test" },
      new RemoteInstanceError("temporarily_unavailable", "Enrollment is temporarily unavailable"),
    );
    expect(result.note).toContain("Enrollment is temporarily unavailable.");
    expect(result.note).toContain("Nothing you answered was lost");
    expect(result.ask).toMatchObject({ kind: "code" });
    expect(result.ask?.question).toContain("h••••@konteks.io");
  });

  it("reads the nameless server error during workspace creation as what it is", async () => {
    // A call that lands while the workspace is still being made comes back as
    // Core's unnamed 500. "The request could not be completed" sends the
    // person hunting for a fault that is not there.
    await writeOnboardState(root, { step: "code", intentRef: "intent-1", emailMasked: "h••••@konteks.io" } as never);
    const result = await onboardFailureStep(
      { root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test" },
      new RemoteInstanceError("temporarily_unavailable", "The request could not be completed"),
    );
    expect(result.note).toContain("still setting up your workspace");
    expect(result.note).toContain("about a minute");
    expect(result.run).toEqual({ argv: ["konteks-remote", "onboard", "--json"] });
    expect(result.ask).toBeUndefined();

    // A bare gateway status while Core restarts is the same situation.
    const gateway = await onboardFailureStep(
      { root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test" },
      new Error("HTTP 502"),
    );
    expect(gateway.note).toContain("still setting up your workspace");
    expect(gateway.ask).toBeUndefined();
  });

  it("offers to try a step that asks nothing again, and ends plainly when access was revoked", async () => {
    await writeOnboardState(root, { step: "initiative", systemId: "sys-1" } as never);
    const context = { root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test" };
    const retry = await onboardFailureStep(context, new RemoteInstanceError("temporarily_unavailable", "Konteks could not be reached."));
    expect(retry.ask).toMatchObject({ kind: "confirm" });
    const revoked = await onboardFailureStep(context, new RemoteInstanceError("permission_denied", OWNER_ACCESS_REVOKED));
    expect(revoked.done?.summary).toContain("revoked");
    expect(revoked.done?.links.site).toBe("https://app.test");
  });

  it("ends without a session when the person answers nothing", async () => {
    await writeOnboardState(root, { step: "first_task", systemId: "sys-1" } as never);
    const fetchFn = vi.fn();
    await step({ fetchFn: fetchFn as never }, "   ");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await readOnboardState(root)).toMatchObject({ step: "done" });
  });

  it("closes with links and the remedies a person may still need", async () => {
    await writeOnboardState(root, {
      step: "done",
      tenantId: "acme",
      systemId: "sys-1",
      systemEntityRef: "system:default/acme-solo",
      repositoryName: "solo",
      repositoryKind: "managed",
      initiativeId: "init-7",
      initiativeTitle: "Book a table",
      initiativeUrl: "https://app.test/work/init-7",
      sessionUrl: "https://app.test/sessions/session-9",
    } as never);
    const result = await step({});
    expect(result.done?.links).toEqual({
      site: "https://app.test",
      system: "https://app.test/systems/sys-1",
      initiative: "https://app.test/work/init-7",
    });
    expect(result.done?.summary).toContain("acme");
    expect(result.done?.summary).toContain("rename it in Settings");
    expect(result.done?.summary).toContain("solo is your first System, kept on Konteks managed git");
    expect(result.done?.summary).toContain('Your first initiative is "Book a table"');
  });

  it("never asks the relaying agent to run anything but konteks-remote", async () => {
    for (const state of ["inspect", "system", "push", "first_task"] as const) {
      await writeOnboardState(root, {
        step: state,
        repositoryName: "solo",
        repositoryKind: "existing",
        repositoryPath: "/tmp/solo",
        defaultBranch: "main",
        remoteUrl: "https://github.com/acme/solo",
        systemId: "sys-1",
        instanceId: "instance-1",
      } as never);
      const result = await step({
        inspect: async () => ({
          path: "/tmp/solo",
          name: "solo",
          remoteUrl: "https://github.com/acme/solo",
          remoteReachable: true,
          currentBranch: "main",
          defaultBranch: "main",
        }),
      });
      if (result.run) expect(result.run.argv[0]).toBe("konteks-remote");
    }
  });

  it("keeps no secret in the state file", async () => {
    await writeOnboardState(root, {
      step: "code",
      intentRef: "intent-1",
      email: "ada@acme.test",
      emailMasked: "a••@acme.test",
    } as never);
    const raw = await readFile(join(root, "onboard-state.json"), "utf8");
    expect(raw).not.toContain("owner-token");
    expect(raw).not.toMatch(/\b\d{6}\b/);
  });

  it("asks which repository is meant when a later run comes from a different one", async () => {
    await writeOnboardState(root, {
      step: "system",
      repositoryName: "acme-shop",
      repositoryKind: "existing",
      repositoryPath: "/tmp/acme-shop",
      defaultBranch: "main",
    } as never);
    const elsewhere = {
      inspect: async () => ({ path: "/tmp/other", name: "other", remoteUrl: null, remoteReachable: false, currentBranch: "main", defaultBranch: "main" }),
    };
    const question = await step(elsewhere);
    expect(question.ask).toMatchObject({ kind: "choice", choices: ["acme-shop", "other"] });
    const switched = await step(elsewhere, "other");
    expect(switched.note).toContain("Switching to other");
    expect(await readOnboardState(root)).toMatchObject({ step: "inspect" });
  });

  it("promises no workspace id before the workspace exists, and says the wait is coming", async () => {
    await writeOnboardState(root, { step: "code", intentRef: "intent-1", email: "hello@konteks.io", emailMasked: "h••••@konteks.io" } as never);
    const verifyCode = vi.fn(async () => ({ decision: "create", proposedTenantId: "konteks" }));
    const result = await step({ enrollment: { verifyCode } as never }, "022667");
    expect(result.note).toContain("creating your workspace");
    expect(result.note).toContain("up to a minute");
    expect(result.note).not.toContain("konteks");
    expect(result.run?.argv).toEqual(["konteks-remote", "onboard", "--json"]);
  });

  it("binds, persists the installation and hands the agent the start command", async () => {
    await writeOnboardState(root, { step: "start", intentRef: "intent-1", email: "ada@acme.test", decision: "create" } as never);
    const { writeSecretFile } = await import("@konteks/remote-common");
    await writeSecretFile(join(root, "native-enrollment.json"), JSON.stringify({
      schemaVersion: 1, coreUrl: "https://core.test", relayUrl: "wss://relay.test", agents: ["claude-code"], releaseId: "release-1", bundleVersion: "0.5.0", manifestDigest: "digest-1", controlPort: 41800,
    }));
    const bind = vi.fn(async () => ({
      identity: { instanceId: "instance-9", workspaceId: "acme" },
      activationId: "activation-9",
      provisioningCredential: "kxrp_x", provisioningCredentialExpiresAt: "2030-01-01T00:00:00Z", provisioningWindowExpiresAt: "2030-01-01T00:00:00Z",
      bundleManifest: {},
      ownerToken: { token: "user-token", expiresAt: new Date(Date.now() + 3600_000).toISOString(), userRef: "user:default/ada", tenantId: "acme" },
      workspaceCreated: true,
    }));
    const complete = vi.fn(async () => ({}) as never);
    const result = await step({ enrollment: { bind } as never, complete, staging: { status: async () => ({ state: "done" }), spawn: vi.fn() } });
    expect(bind).toHaveBeenCalledWith("intent-1", { email: "ada@acme.test", expectedManifestDigest: "digest-1" });
    expect(complete).toHaveBeenCalledWith(root, { instanceId: "instance-9", workspaceId: "acme" });
    expect(result.run?.argv).toEqual(["konteks-remote", "start"]);
    expect(result.note).toContain("Your workspace is ready: acme");
    expect(result.note).toContain("rename it in Settings");
    const state = await readOnboardState(root);
    expect(state).toMatchObject({ step: "inspect", instanceId: "instance-9", tenantId: "acme" });
    expect(state?.email).toBeUndefined();
    expect(JSON.parse(await readFile(join(root, "supervisor", "owner-token.json"), "utf8"))).toMatchObject({ token: "user-token", instanceId: "instance-9" });
  });

  it("says how far the agent packages have unpacked instead of waiting silently, and names the workspace once", async () => {
    await writeOnboardState(root, { step: "start", intentRef: "intent-1", email: "ada@acme.test", decision: "create" } as never);
    const { writeSecretFile } = await import("@konteks/remote-common");
    await writeSecretFile(join(root, "native-enrollment.json"), JSON.stringify({
      schemaVersion: 1, coreUrl: "https://core.test", relayUrl: "wss://relay.test", agents: ["claude-code", "codex"], bundleVersion: "0.5.0", manifestDigest: "digest-1", controlPort: 41800,
    }));
    const bind = vi.fn(async () => ({
      identity: { instanceId: "instance-9", workspaceId: "acme" },
      ownerToken: { token: "user-token", expiresAt: new Date(Date.now() + 3600_000).toISOString(), userRef: "user:default/ada", tenantId: "acme" },
    }));
    const complete = vi.fn(async () => ({}) as never);
    let status: { state: "running"; agent: string; done: number; total: number } | { state: "done" } = { state: "running", agent: "codex", done: 1, total: 2 };
    const staging = { status: vi.fn(async () => status), spawn: vi.fn(), waitMs: 5 };
    const { SupervisorStore } = await import("@konteks/remote-supervisor");
    vi.spyOn(SupervisorStore.prototype, "identity").mockResolvedValue(null as never);

    const first = await step({ enrollment: { bind } as never, complete, staging });
    expect(first.note).toContain("Your workspace is ready: acme");
    expect(first.note).toContain("Codex, 2 of 2");
    expect(first.run?.argv).toEqual(["konteks-remote", "onboard", "--json"]);
    expect(complete).not.toHaveBeenCalled();
    expect(staging.spawn).not.toHaveBeenCalled();

    vi.spyOn(SupervisorStore.prototype, "identity").mockResolvedValue({ instanceId: "instance-9", workspaceId: "acme" } as never);
    status = { state: "done" };
    const second = await step({ enrollment: { bind } as never, complete, staging });
    expect(bind).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(second.note).not.toContain("Your workspace is ready");
    expect(second.run?.argv).toEqual(["konteks-remote", "start"]);
    vi.restoreAllMocks();
  });

  it("starts the unpacking again when it stopped, and says so", async () => {
    await writeOnboardState(root, { step: "start", decision: "join", workspaceAnnounced: true } as never);
    const { SupervisorStore } = await import("@konteks/remote-supervisor");
    vi.spyOn(SupervisorStore.prototype, "identity").mockResolvedValue({ instanceId: "instance-9", workspaceId: "acme" } as never);
    const staging = { status: vi.fn(async () => ({ state: "failed" as const, message: "Unpacking the agent packages stopped before it finished." })), spawn: vi.fn(async () => 123), waitMs: 5 };
    const result = await step({ staging, complete: vi.fn() as never });
    expect(staging.spawn).toHaveBeenCalledWith(root);
    expect(result.note).toContain("started again");
    expect(result.note).not.toContain("joining");
    vi.restoreAllMocks();
  });

  it("recovers from a bind whose answer was lost by sending a new code to the same address", async () => {
    await writeOnboardState(root, { step: "start", intentRef: "intent-1", email: "hello@konteks.io", decision: "create" } as never);
    const { writeSecretFile, RemoteInstanceError: Refusal } = await import("@konteks/remote-common");
    await writeSecretFile(join(root, "native-enrollment.json"), JSON.stringify({
      schemaVersion: 1, coreUrl: "https://core.test", relayUrl: "wss://relay.test", agents: [], bundleVersion: "0.5.0", manifestDigest: "digest-1", controlPort: 41800,
    }));
    const bind = vi.fn(async () => { throw new Refusal("enrollment_invalid" as never, "This enrollment was not accepted"); });
    const lost = await step({ enrollment: { bind } as never });
    expect(lost.note).toContain("did not hear back");
    expect(lost.ask).toBeUndefined();
    const openIntent = vi.fn(async () => ({ intentRef: "intent-2" }));
    const sendChallenge = vi.fn(async () => ({ sentToMasked: "h••••@konteks.io", attemptsRemaining: 5 }));
    const resent = await step({ enrollment: { openIntent, sendChallenge } as never });
    expect(sendChallenge).toHaveBeenCalledWith("intent-2", "hello@konteks.io");
    expect(resent.note).toContain("h••••@konteks.io");
    expect(await readOnboardState(root)).toMatchObject({ step: "code", intentRef: "intent-2" });
    expect((await readOnboardState(root))?.resendTo).toBeUndefined();
  });

  it("stops with the plan-limit remedy, naming the machine that holds it, and can try again later", async () => {
    await writeOnboardState(root, { step: "start", intentRef: "intent-1", email: "ada@acme.test", decision: "join" } as never);
    const { writeSecretFile, CoreResponseError } = await import("@konteks/remote-common");
    await writeSecretFile(join(root, "native-enrollment.json"), JSON.stringify({
      schemaVersion: 1, coreUrl: "https://core.test", relayUrl: "wss://relay.test", agents: [], releaseId: "release-1", bundleVersion: "0.5.0", manifestDigest: "digest-1", controlPort: 41800,
    }));
    const bind = vi.fn(async () => {
      throw new CoreResponseError({ status: 402, code: "limit_exceeded", message: "This workspace's plan allows one connected runtime, and \"ada's Mac\" already holds it" });
    });
    const result = await step({ enrollment: { bind } as never });
    // W1-A10: the refusal names the machine to revoke, and says how to move.
    expect(result.done?.summary).toContain("\"ada's Mac\" already holds it.");
    expect(result.done?.summary).toContain("revoke that runtime in Settings → Connected runtimes, then run onboard again here");
    expect(result.done?.links.site).toContain("/settings/runtimes");
    // "Run onboard again" must actually try again: a fresh code, not a replayed summary.
    expect(await readOnboardState(root)).toMatchObject({ step: "email", resendTo: "ada@acme.test" });
  });

  it("re-asks for the code with the attempts left, and starts over once the code can no longer be used", async () => {
    await writeOnboardState(root, { step: "code", intentRef: "intent-1", email: "ada@acme.test", emailMasked: "a••@acme.test", attemptsRemaining: 3 } as never);
    const { CoreResponseError } = await import("@konteks/remote-common");
    const verifyCode = vi
      .fn()
      .mockRejectedValueOnce(new CoreResponseError({ status: 400, code: "code_invalid", message: "no" }))
      .mockRejectedValueOnce(new CoreResponseError({ status: 401, code: "enrollment_invalid", message: "no" }));
    const first = await step({ enrollment: { verifyCode } as never }, "000000");
    expect(first.ask).toMatchObject({ kind: "code" });
    expect(first.note).toContain("2 attempts left");
    const second = await step({ enrollment: { verifyCode } as never }, "000001");
    expect(second.note).toContain("a new one will be sent");
    expect(second.run?.argv).toEqual(["konteks-remote", "onboard", "--json"]);
    // The promise holds: the email step sends to the same address instead of asking for it.
    expect(await readOnboardState(root)).toMatchObject({ step: "email", resendTo: "ada@acme.test" });
  });

  it("ends the flow on an empty answer to the first task, not only on whitespace", async () => {
    await writeOnboardState(root, { step: "first_task", systemId: "sys-1", instanceId: "instance-1" } as never);
    const result = await step({}, "");
    expect(result.note).toBe("Ending here.");
    expect(await readOnboardState(root)).toMatchObject({ step: "done" });
  });
});
