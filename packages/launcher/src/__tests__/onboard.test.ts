import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initiativeTitle, isNo, isYes, onboardFailureStep, runOnboard, runOnboardStep } from "../native/onboard.js";
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
    // Every machine these tests describe can still prove itself; the lost-key
    // test (W1-L1) says otherwise for itself.
    const { SupervisorStore } = await import("@konteks/remote-supervisor");
    vi.spyOn(SupervisorStore.prototype, "loadInstanceKey").mockResolvedValue({} as never);
    root = await mkdtemp(join(tmpdir(), "konteks-onboard-"));
    await writeOwnerToken(join(root, "supervisor"), {
      token: "owner-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      userRef: "user:default/ada",
      tenantId: "acme",
      instanceId: "instance-1",
    }).catch(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

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

  it("closes the conversation that just finished with its summary, not a revisit (pass 25)", async () => {
    const { SupervisorStore } = await import("@konteks/remote-supervisor");
    vi.spyOn(SupervisorStore.prototype, "identity").mockResolvedValue({ instanceId: "instance-1", workspaceId: "konteks-2" } as never);
    await writeOnboardState(root, {
      step: "done", closing: true, tenantId: "konteks-2", ownerEmail: "hello@konteks.io",
      systemEntityRef: "system:default/konteks-2-onboard-app", systemId: "sys-1",
    } as never);
    const closing = await step({ families: async () => ["claude-code", "codex"] });
    expect(closing.done?.summary).toContain("connected to your workspace konteks-2");
    expect(closing.note ?? "").not.toContain("already connected");
    // A later conversation is a revisit again.
    expect(await readOnboardState(root)).toMatchObject({ step: "done", closing: false });
    const later = await step({});
    expect(later.note).toContain("already connected to konteks-2");
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
    // No System, so no first initiative to ask about: this conversation closes (pass 27).
    expect(declined.note).toContain("run onboard here again");
    expect(await readOnboardState(root)).toMatchObject({ step: "done", closing: true });
  });

  it("names the initiative a rejoined System already has instead of asking for a first one (WS1-090)", async () => {
    await writeOnboardState(root, { step: "first_task", systemExisting: true, systemId: "sys-existing", repositoryName: "hello-world", instanceId: "instance-1" } as never);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ initiatives: [{ id: "init_1", title: "Turn this into a tiny page that greets visitors by the time of day" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await step({ fetchFn: fetchFn as never });
    expect(result.ask).toBeUndefined();
    expect(result.note).toBe('hello-world already has an initiative, "Turn this into a tiny page that greets visitors by the time of day", so no new one is started: https://app.test/work/init_1');
    expect(await readOnboardState(root)).toMatchObject({ step: "done", initiativeId: "init_1" });
    // A System with none still gets the question.
    await writeOnboardState(root, { step: "first_task", systemExisting: true, systemId: "sys-existing", repositoryName: "hello-world", instanceId: "instance-1" } as never);
    const empty = vi.fn(async () => new Response(JSON.stringify({ initiatives: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    expect((await step({ fetchFn: empty as never })).ask?.kind).toBe("text");
  });

  it("says so when the folder was already the workspace's System, instead of failing (WS1-089)", async () => {
    await writeOnboardState(root, { step: "system", repositoryName: "hello-world", repositoryKind: "existing", repositoryPath: "/tmp/hello-world", remoteUrl: "https://github.com/octocat/Hello-World.git", defaultBranch: "master", instanceId: "instance-1" } as never);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      systemId: "sys-existing", existing: true, systemEntityRef: "system:default/konteks-2-hello-world", componentEntityRef: "component:default/octocat-hello-world",
      repository: { kind: "existing", remoteUrl: "https://github.com/octocat/Hello-World.git", defaultBranch: "master" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await step({ fetchFn: fetchFn as never }, "yes");
    expect(result.note).toBe("hello-world was already a System in your workspace, so this machine works on that one; nothing was made twice.");
    expect(await readOnboardState(root)).toMatchObject({ step: "graft", systemId: "sys-existing" });
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

  it("waits while Konteks is still setting up managed git, instead of asking to retry (WS1-048)", async () => {
    await writeOnboardState(root, {
      step: "system", repositoryName: "solo", repositoryKind: "managed", repositoryPath: "/tmp/solo", defaultBranch: "trunk", instanceId: "instance-1",
    } as never);
    const settingUp = () => new Response(JSON.stringify({ error: "managed_git_setting_up", message: "Konteks is still setting up managed git for this workspace. It takes about a minute; nothing you answered was lost." }), { status: 503, headers: { "content-type": "application/json" } });
    const registered = () => new Response(JSON.stringify({
      systemId: "sys-1", systemEntityRef: "system:default/acme-solo", componentEntityRef: "component:default/acme-solo",
      repository: { kind: "managed", remoteUrl: "https://git.konteks.test/acme/solo", defaultBranch: "trunk" },
    }), { status: 201, headers: { "content-type": "application/json" } });
    const fetchFn = vi.fn().mockResolvedValueOnce(settingUp()).mockResolvedValueOnce(settingUp()).mockResolvedValueOnce(registered());
    const result = await step({ fetchFn: fetchFn as never, managedGitPollMs: 1 }, "yes");
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result.note).toContain("is now a System");

    // Past the wait it says what is happening, once, and offers to try again.
    await writeOnboardState(root, {
      step: "system", repositoryName: "solo", repositoryKind: "managed", repositoryPath: "/tmp/solo", defaultBranch: "trunk", instanceId: "instance-1",
    } as never);
    const always = vi.fn(async () => settingUp());
    const error = await step({ fetchFn: always as never, managedGitPollMs: 1, managedGitWaitMs: 0 }, "yes").catch((e: unknown) => e);
    const failed = await onboardFailureStep({ root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test" }, error);
    expect(failed.note).toBe("Konteks could not finish that step: Konteks is still setting up managed git for this workspace. It takes about a minute; nothing you answered was lost.");
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
    // WS1-049: a refusal that says why keeps its words.
    const named = await step({ fetchFn: refusal({ code: "access_denied", message: "The session proof was not accepted" }) as never }, "yes").catch((e: unknown) => e);
    expect((named as Error).message).toBe("Konteks refused that request: The session proof was not accepted.");
  });

  it("hands the agent the next question with the note, instead of a bare run-again hop (WS1-032)", async () => {
    await writeOnboardState(root, {
      step: "system", repositoryName: "solo", repositoryKind: "managed", repositoryPath: "/tmp/solo", repositoryNeedsInit: true, defaultBranch: "trunk", instanceId: "instance-1",
    } as never);
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({
        systemId: "sys-1", systemEntityRef: "system:default/acme-solo", componentEntityRef: "component:default/acme-solo",
        repository: { kind: "managed", remoteUrl: "https://git.konteks.test/acme/solo", defaultBranch: "trunk" },
      }), { status: 201, headers: { "content-type": "application/json" } }),
    );
    const result = await runOnboard({
      root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test", answer: "yes",
      deps: { waitForReady: readyService, fetchFn: fetchFn as never },
    });
    expect(result.note).toContain("is now a System");
    expect(result.ask?.question).toContain("Push solo to Konteks managed git now?");
    expect(result.run).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // A step that did not move on (still starting) goes back to the agent as it is.
    await writeOnboardState(root, { step: "inspect" } as never);
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(join(root, "native-runtime.json"), JSON.stringify({ schemaVersion: 1, deploymentKind: "native_connector", instanceId: "instance-1", workspaceId: "konteks-2", releaseId: "release-1", manifestDigest: "d", bundleVersion: "0.4.1", coreUrl: "https://core.test", relayUrl: "wss://core.test/relay", agents: ["claude-code"], controlPort: 41800 }));
    await chmod(join(root, "native-runtime.json"), 0o600);
    const waiting = await runOnboard({ root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test", deps: { waitForReady: async () => null } });
    expect(waiting.run).toEqual({ argv: ["konteks-remote", "onboard", "--json"] });
    expect(waiting.note).toContain("still starting");
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
    expect(await readOnboardState(root)).toMatchObject({ step: "graft" }); // Graft is offered next (W1-G1).
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
    // WS1-079: never "ask again in a moment", which read as an invitation to
    // poll; the run already says what comes next.
    expect(result.note).not.toMatch(/ask again/i);
    expect(await readOnboardState(root)).toMatchObject({ step: "inspect", startWaits: 1 });

    // WS1-036: the record exists before `start` is ever run, so "starting"
    // must not be said for ever. The second wait (each is over a minute)
    // hands out start again.
    const again = () => runOnboardStep({
      root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test", cwd: "/tmp/projects/konteks-onboard-app",
      deps: { waitForReady: async () => null, inspect: async () => { throw new Error("must not inspect"); } },
    });
    const second = await again();
    expect(second.run).toEqual({ argv: ["konteks-remote", "start"] });
    expect(second.note).toContain("safe if it is already running");
    expect(await readOnboardState(root)).toMatchObject({ step: "inspect", startWaits: 0 });
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
    expect(question.ask?.question).toContain("joined to the repository Konteks made for it; none of your files are added or changed");
    expect(question.ask?.question).not.toContain("empty first commit"); // WS1-031: the repository usually has its own
    expect(question.ask?.question).toContain("none of your files are added");
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

  it("starts a stopped service instead of asking to retry the push, and keeps the person's yes (WS1-027)", async () => {
    await writeOnboardState(root, {
      step: "pushing", repositoryName: "solo", repositoryPath: "/tmp/solo",
      managedRemoteUrl: "https://git.konteks.test/acme/solo", managedSshUrl: "ssh://git@git.konteks.test:2222/acme/solo.git", defaultBranch: "main",
    } as never);
    const push = vi.fn();
    const registerGitKey = vi.fn(async () => { throw new RemoteInstanceError("control_socket_unavailable", "cannot reach the supervisor control socket"); });
    const result = await step({ registerGitKey, push: push as never });
    expect(push).not.toHaveBeenCalled();
    expect(result.note).toContain("service on this machine is not running");
    expect(result.run).toEqual({ argv: ["konteks-remote", "start"] });
    expect(result.ask).toBeUndefined();
    expect(await readOnboardState(root)).toMatchObject({ step: "pushing" });
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
    expect(await readOnboardState(root)).toMatchObject({ step: "graft" });
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
    // WS1-083: a long sentence is cut where a phrase ends, not mid-phrase.
    expect(initiativeTitle("I want a very small booking site for my cafe where regulars can reserve the window table and get a reminder the day before.")).toBe(
      "I want a very small booking site for my cafe where regulars can reserve the window table",
    );
    expect(initiativeTitle("A simple site where people can book a table at my restaurant for a date and time, and I get an email for each booking.")).toBe(
      "A simple site where people can book a table at my restaurant for a date and time",
    );
    // With no phrase end in reach it still cuts at a word, marked as cut.
    const long = initiativeTitle("Build a reservation calendar synchronisation dashboard integrating multiple restaurant locations' availability feeds automatically nightly.");
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

  it("names only the agents that are logged in as running work, and says how to log in the other (pass 28)", async () => {
    await writeOnboardState(root, { step: "done", tenantId: "acme" } as never);
    const result = await step({ families: async () => ["claude-code", "codex"], agentReadiness: async () => ({ "claude-code": "ready", codex: "login_required" }) });
    expect(result.done?.summary).toContain("Your Claude Code login will run Konteks work here.");
    expect(result.done?.summary).not.toContain("claude-code and codex");
    expect(result.done?.remedies).toContain("Codex is installed but not logged in here, so it will not run Konteks work yet. To log it in: konteks-remote auth login codex");
    // A service still probing is not evidence of a missing login.
    const probing = await step({ families: async () => ["claude-code", "codex"], agentReadiness: async () => ({ "claude-code": "ready", codex: "probing" }) });
    expect(probing.done?.summary).toContain("Your Claude Code and Codex login will run Konteks work here.");
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

  it("tells the person the workspace is being made before the long bind starts, never chaining into it (WS1-076)", async () => {
    await writeOnboardState(root, { step: "code", intentRef: "intent-1", email: "hello@konteks.io", emailMasked: "h••••@konteks.io" } as never);
    const verifyCode = vi.fn(async () => ({ decision: "create", proposedTenantId: "konteks" }));
    const bind = vi.fn(async () => { throw new Error("the bind must wait for the next invocation"); });
    const result = await runOnboard({
      root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test", answer: "022667",
      deps: { waitForReady: readyService, enrollment: { verifyCode, bind } as never },
    });
    expect(result.note).toContain("creating your workspace");
    expect(result.note).toContain("up to a minute");
    expect(result.run?.argv).toEqual(["konteks-remote", "onboard", "--json"]);
    expect(bind).not.toHaveBeenCalled();
    expect(await readOnboardState(root)).toMatchObject({ step: "start" });
  });

  it("stops with Konteks's own words when it does not connect this machine's release, instead of asking the email again (WS1-077)", async () => {
    await writeOnboardState(root, { step: "email", email: "hello@konteks.io" } as never);
    const said = "This machine installed connector release 0.1.0-e2e, but Konteks connects release 0.4.1-e2e right now, so nothing was set up and no code was sent. Run the install command again to get the current release, then carry on";
    const result = await onboardFailureStep(
      { root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test", answer: "hello@konteks.io" },
      new RemoteInstanceError("update_required", said),
    );
    expect(result.ask).toBeUndefined();
    expect(result.done?.summary).toBe(`${said}.`);
    expect(result.done?.links.site).toBe("https://app.test");
    // A fresh install starts the conversation again from the first question.
    const state = await readOnboardState(root);
    expect(state).toMatchObject({ step: "identity" });
    expect((state as { intentRef?: string }).intentRef).toBeUndefined();
  });

  it("shows what a folder with files would commit, and what it leaves out, then commits exactly that and pushes (W1-B2)", async () => {
    await writeOnboardState(root, {
      step: "push", repositoryPath: "/tmp/cafe", repositoryName: "cafe", repositoryNeedsInit: true, defaultBranch: "main",
      managedRemoteUrl: "https://git.konteks.test/acme/cafe", systemId: "sys-1", ownerEmail: "hello@konteks.io",
    } as never);
    const plan = { include: ["README.md", "package.json", "src/app.js"], leftOut: [{ path: ".env", why: "it can hold secrets" }, { path: "node_modules/", why: "installed packages" }] };
    const planCommit = vi.fn(async () => plan);
    const asked = await step({ planCommit });
    expect(asked.ask?.question).toBe("Push cafe to Konteks managed git now? The folder becomes a git repository on main, joined to the repository Konteks made for it, with one commit of your 3 files.");
    expect(asked.note).toBe("The commit would hold README.md, package.json and src/app.js. Left out: .env (it can hold secrets) and node_modules/ (installed packages). A .gitignore listing them is added so they stay out.");

    await step({ planCommit }, "yes");
    const initialize = vi.fn(async () => ({ ok: true, adopted: true, message: "cafe is now a git repository on main." }));
    const commitFiles = vi.fn(async () => ({ ok: true, message: 'Committed 3 files as "Add cafe".' }));
    const push = vi.fn(async () => ({ pushed: true, message: "Pushed main to Konteks managed git." }));
    const pushed = await step({ planCommit, initialize: initialize as never, commitFiles, push: push as never });
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ keepFiles: true }));
    expect(commitFiles).toHaveBeenCalledWith({ path: "/tmp/cafe", plan, authorName: "hello", authorEmail: "hello@konteks.io", message: "Add cafe" });
    expect(push).toHaveBeenCalled();
    expect(pushed.note).toContain("Pushed main to Konteks managed git.");
    expect(await readOnboardState(root)).toMatchObject({ step: "graft" });
  });

  describe("Graft (W1-G1..G3, WS1-081)", () => {
    const plan = async () => ({ agents: ["claude", "agents"], adds: ["graft/", ".claude/", ".mcp.json", "AGENTS.md"], tracked: [] as string[], files: 3 });
    const graftDeps = (extra: Record<string, unknown> = {}) => ({
      families: async () => ["claude-code", "codex"],
      graft: { available: async () => true, wired: async () => false, plan, ...extra } as never,
    });
    const atGraft = () => writeOnboardState(root, { step: "graft", repositoryPath: "/tmp/table-booking", repositoryName: "table-booking", systemId: "sys-1" } as never);

    it("offers Graft once the folder is a repository, naming what it adds and what it never does", async () => {
      await atGraft();
      const offer = await step(graftDeps());
      expect(offer.ask).toMatchObject({ kind: "confirm" });
      expect(offer.ask?.question).toBe("Set up Graft in table-booking? It adds graft/, .claude/, .mcp.json and AGENTS.md here, kept out of your commits.");
      expect(offer.note).toContain("so Claude Code and Codex can find their way around it");
      expect(offer.note).toContain("sends nothing to a paid model, and its usage statistics stay off");
      expect(offer.note).toContain("Outside this folder it writes only its own settings in ~/.graft");
    });

    it("says a tracked file Graft would change will show in git", async () => {
      await atGraft();
      const offer = await step(graftDeps({ plan: async () => ({ ...(await plan()), tracked: ["AGENTS.md"] }) }));
      expect(offer.note).toContain("AGENTS.md is already tracked by git, so Graft's section there will show as a change");
    });

    it("sets it up after a yes, saying first how long it takes, then carries on to the first task", async () => {
      await atGraft();
      const ensure = vi.fn(async () => ({ node: "/n", cli: "/c" }));
      const wire = vi.fn(async () => ({ added: [".claude/settings.json", ".mcp.json", "AGENTS.md", "graft/"], changedTracked: [] as string[], mappedFiles: 3 }));
      const yes = await step(graftDeps({ ensure, wire }), "yes");
      expect(yes.note).toMatch(/^Setting up Graft: downloading it, then building its map of table-booking \(3 files\)\. That usually takes under \d+ seconds\.$/);
      expect(ensure).not.toHaveBeenCalled();
      expect(await readOnboardState(root)).toMatchObject({ step: "graft_setup", graftDecision: "accepted" });

      const done = await step(graftDeps({ ensure, wire }));
      expect(wire).toHaveBeenCalledWith(root, "/tmp/table-booking", ["claude-code", "codex"], { node: "/n", cli: "/c" });
      expect(done.note).toContain("Graft is set up in table-booking: its map covers 3 files.");
      expect(done.note).toContain("which git leaves out of your commits on this machine");
      expect(await readOnboardState(root)).toMatchObject({ step: "first_task" });
    });

    it("never enters the setup in the same invocation as the yes", async () => {
      await atGraft();
      const wire = vi.fn();
      const result = await runOnboard({ root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test", answer: "yes", deps: { waitForReady: readyService, ...graftDeps({ wire }) } });
      expect(result.note).toContain("Setting up Graft");
      expect(wire).not.toHaveBeenCalled();
    });

    it("adds nothing on a no, and never asks again for that folder (W1-G2)", async () => {
      await atGraft();
      const wire = vi.fn();
      const no = await step(graftDeps({ wire }), "no thanks");
      expect(no.note).toBe("Graft was not set up; nothing was added, and it will not be offered again for this folder.");
      expect(wire).not.toHaveBeenCalled();
      expect(await readOnboardState(root)).toMatchObject({ step: "first_task", graftDecision: "declined", graftRepository: "/tmp/table-booking" });

      await writeOnboardState(root, { ...(await readOnboardState(root))!, step: "graft" } as never);
      const again = await step(graftDeps());
      expect(again.ask).toBeUndefined();
      expect(await readOnboardState(root)).toMatchObject({ step: "first_task" });
    });

    it("does not offer Graft again in a folder it already wired (WS1-090)", async () => {
      await atGraft();
      const result = await step(graftDeps({ wired: async () => true }));
      expect(result.ask).toBeUndefined();
      expect(result.note).toBe("Graft is already set up in table-booking.");
      expect(await readOnboardState(root)).toMatchObject({ step: "first_task", graftDecision: "accepted" });
    });

    it("goes straight on when the release has no Graft", async () => {
      await atGraft();
      const result = await step({ families: async () => ["claude-code"], graft: { available: async () => false } as never });
      expect(result.ask).toBeUndefined();
      expect(result.note).toBeUndefined();
      expect(await readOnboardState(root)).toMatchObject({ step: "first_task", graftDecision: "unavailable" });
    });

    it("says plainly when the setup failed and carries on", async () => {
      await writeOnboardState(root, { step: "graft_setup", repositoryPath: "/tmp/table-booking", repositoryName: "table-booking" } as never);
      const failed = await step(graftDeps({ ensure: async () => { throw new Error("the downloaded Graft package does not match this release's checksum, so it was not installed."); } }));
      expect(failed.note).toBe("Graft could not be set up (the downloaded Graft package does not match this release's checksum, so it was not installed). Nothing else changed, and onboarding carries on.");
      expect(await readOnboardState(root)).toMatchObject({ step: "first_task", graftDecision: "failed" });
    });
  });

  it("connects a machine that lost its key again, as a replacement for the runtime it was (W1-L1)", async () => {
    const { SupervisorStore } = await import("@konteks/remote-supervisor");
    await new SupervisorStore(join(root, "supervisor")).saveIdentity({
      instanceId: "instance-old", workspaceId: "acme", activationId: "act-1", activatedAt: new Date().toISOString(), administrativeStatus: "active", exchangeNonce: "n-1",
    });
    vi.spyOn(SupervisorStore.prototype, "loadInstanceKey").mockResolvedValue(null);
    await writeOnboardState(root, { step: "done", email: "ada@acme.test", tenantId: "acme", instanceId: "instance-old" } as never);

    const result = await step({});
    expect(result.note).toContain("lost its Konteks key");
    expect(result.note).toContain("takes the old one's place");
    expect(result.run?.argv).toEqual(["konteks-remote", "onboard", "--json"]);
    expect(await readOnboardState(root)).toMatchObject({ step: "email", replaces: "instance-old", resendTo: "ada@acme.test" });
    // The old identity is set aside, not deleted, and the machine starts empty.
    const { readdir } = await import("node:fs/promises");
    const [aside] = await readdir(join(root, "retired"));
    expect(aside).toMatch(/^instance-old-/);
    expect(await readdir(join(root, "retired", aside!, "supervisor"))).toContain("identity.json");
    expect(await new SupervisorStore(join(root, "supervisor")).identity()).toBeNull();
  });

  it("names the runtime a bind replaces", async () => {
    await writeOnboardState(root, { step: "start", intentRef: "intent-1", email: "ada@acme.test", decision: "join", tenantId: "acme", replaces: "instance-old" } as never);
    const { writeSecretFile } = await import("@konteks/remote-common");
    await writeSecretFile(join(root, "native-enrollment.json"), JSON.stringify({
      schemaVersion: 1, coreUrl: "https://core.test", relayUrl: "wss://relay.test", agents: ["claude-code"], releaseId: "release-1", bundleVersion: "0.5.0", manifestDigest: "digest-1", controlPort: 41800,
    }));
    const bind = vi.fn(async () => { throw new Error("stop here"); });
    await step({ enrollment: { bind } as never, staging: { status: async () => ({ state: "done" }), spawn: vi.fn() } }).catch(() => undefined);
    expect(bind).toHaveBeenCalledWith("intent-1", { email: "ada@acme.test", tenantId: "acme", replacesInstanceId: "instance-old", expectedManifestDigest: "digest-1" });
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
    expect(first.note).toContain('say "send a new code"');
    const second = await step({ enrollment: { verifyCode } as never }, "000001");
    expect(second.note).toBe("That code was not accepted either, and after five wrong codes a code stops working, to keep your account safe. A new one will be sent.");
    expect(second.run?.argv).toEqual(["konteks-remote", "onboard", "--json"]);
    // The promise holds: the email step sends to the same address instead of asking for it.
    expect(await readOnboardState(root)).toMatchObject({ step: "email", resendTo: "ada@acme.test" });
  });

  it("says why a new code comes after the fifth wrong one, in the same reply as the new code (W1-Z2)", async () => {
    await writeOnboardState(root, { step: "code", intentRef: "intent-1", email: "ada@acme.test", emailMasked: "a••@acme.test", attemptsRemaining: 1 } as never);
    const { CoreResponseError } = await import("@konteks/remote-common");
    const enrollment = {
      verifyCode: vi.fn().mockRejectedValueOnce(new CoreResponseError({ status: 401, code: "enrollment_invalid", message: "no" })),
      openIntent: vi.fn(async () => ({ intentRef: "intent-2" })),
      sendChallenge: vi.fn(async () => ({ sentToMasked: "a••@acme.test", attemptsRemaining: 5 })),
    };
    const { writeSecretFile } = await import("@konteks/remote-common");
    await writeSecretFile(join(root, "native-enrollment.json"), JSON.stringify({
      schemaVersion: 1, coreUrl: "https://core.test", relayUrl: "wss://relay.test", agents: [], bundleVersion: "0.5.0", manifestDigest: "digest-1", controlPort: 41800,
    }));
    const result = await runOnboard({ root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test", answer: "428913", deps: { waitForReady: readyService, enrollment: enrollment as never, fetchFn: (async () => { throw new Error("no fetch"); }) as never } });
    expect(result.note).toContain("after five wrong codes a code stops working, to keep your account safe.");
    expect(result.note).toContain("A new six-digit code is on its way to a••@acme.test.");
    expect(result.ask).toMatchObject({ kind: "code" });
    expect(enrollment.sendChallenge).toHaveBeenCalledWith("intent-2", "ada@acme.test");
    expect((await readOnboardState(root))?.resendReason).toBeUndefined();
  });

  it("sends a new code when the person asks for one, and says when it is too soon (WS1-088)", async () => {
    await writeOnboardState(root, { step: "code", intentRef: "intent-1", email: "ada@acme.test", emailMasked: "a••@acme.test", attemptsRemaining: 5 } as never);
    const { CoreResponseError } = await import("@konteks/remote-common");
    const sendChallenge = vi
      .fn()
      .mockRejectedValueOnce(new CoreResponseError({ status: 409, code: "challenge_active", message: "wait" }))
      .mockResolvedValueOnce({ sentToMasked: "a••@acme.test", attemptsRemaining: 5 });
    const verifyCode = vi.fn();
    const soon = await step({ enrollment: { sendChallenge, verifyCode } as never }, "I didn't get it");
    expect(soon.note).toContain("less than a minute ago");
    expect(soon.ask).toMatchObject({ kind: "code" });
    const again = await step({ enrollment: { sendChallenge, verifyCode } as never }, "send a new code");
    expect(again.note).toBe("A new code is on its way to a••@acme.test; the one before it no longer works.");
    expect(verifyCode).not.toHaveBeenCalled();

    // A mistyped address goes back to the email question.
    const other = await step({ enrollment: { sendChallenge, verifyCode } as never }, "oops, use a different email");
    expect(other.ask).toMatchObject({ kind: "email" });
    expect(await readOnboardState(root)).toMatchObject({ step: "email" });
    expect((await readOnboardState(root))?.email).toBeUndefined();
  });

  it("ends the flow on an empty answer to the first task, not only on whitespace", async () => {
    await writeOnboardState(root, { step: "first_task", systemId: "sys-1", instanceId: "instance-1" } as never);
    const result = await step({}, "");
    expect(result.note).toBe("Ending here.");
    expect(await readOnboardState(root)).toMatchObject({ step: "done" });
  });
});
