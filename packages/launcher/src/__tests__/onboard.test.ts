import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initiativeTitle, onboardFailureStep, runOnboardStep } from "../native/onboard.js";
import { RemoteInstanceError } from "@konteks/remote-common";
import { readOnboardState, writeOnboardState } from "../native/onboard-state.js";
import { writeOwnerToken } from "../native/owner-api.js";
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

  const step = (extra: Parameters<typeof runOnboardStep>[0]["deps"] = {}, answer?: string) =>
    runOnboardStep({
      root,
      output: output(),
      coreUrl: "https://core.test",
      siteUrl: "https://app.test",
      ...(answer !== undefined ? { answer } : {}),
      deps: extra,
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
        waitForReady: async () => null,
        inspect: async () => ({ path: null, name: "me", remoteUrl: null, remoteReachable: false, currentBranch: null, defaultBranch: "main" }),
      },
    });
    expect(result.note).toContain("home folder");
    expect(await readOnboardState(root)).toMatchObject({ step: "first_task" });
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
    expect(initialize).toHaveBeenCalledWith({
      path: "/tmp/projects/konteks-onboard-app",
      branch: "main",
      authorName: "hello",
      authorEmail: "hello@konteks.io",
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(pushed.note).toContain("https://app.test/systems/sys-1");
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
    expect(calls[1]!.body).toMatchObject({ content: sentence });
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

  it("offers to try a step that asks nothing again, and ends plainly when access was revoked", async () => {
    await writeOnboardState(root, { step: "initiative", systemId: "sys-1" } as never);
    const context = { root, output: output(), coreUrl: "https://core.test", siteUrl: "https://app.test" };
    const retry = await onboardFailureStep(context, new RemoteInstanceError("temporarily_unavailable", "Konteks could not be reached."));
    expect(retry.ask).toMatchObject({ kind: "confirm" });
    const revoked = await onboardFailureStep(context, new RemoteInstanceError("permission_denied", "This machine's Konteks access for you was revoked; sign in on the site or enroll again."));
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
    const result = await step({ enrollment: { bind } as never, complete });
    expect(bind).toHaveBeenCalledWith("intent-1", { email: "ada@acme.test", expectedManifestDigest: "digest-1" });
    expect(complete).toHaveBeenCalledWith(root, { instanceId: "instance-9", workspaceId: "acme" });
    expect(result.run?.argv).toEqual(["konteks-remote", "start"]);
    const state = await readOnboardState(root);
    expect(state).toMatchObject({ step: "inspect", instanceId: "instance-9", tenantId: "acme" });
    expect(state?.email).toBeUndefined();
    expect(JSON.parse(await readFile(join(root, "supervisor", "owner-token.json"), "utf8"))).toMatchObject({ token: "user-token", instanceId: "instance-9" });
  });

  it("stops with the plan-limit remedy instead of retrying the bind on every run", async () => {
    await writeOnboardState(root, { step: "start", intentRef: "intent-1", email: "ada@acme.test", decision: "join" } as never);
    const { writeSecretFile, CoreResponseError } = await import("@konteks/remote-common");
    await writeSecretFile(join(root, "native-enrollment.json"), JSON.stringify({
      schemaVersion: 1, coreUrl: "https://core.test", relayUrl: "wss://relay.test", agents: [], releaseId: "release-1", bundleVersion: "0.5.0", manifestDigest: "digest-1", controlPort: 41800,
    }));
    const bind = vi.fn(async () => { throw new CoreResponseError({ status: 402, code: "limit_exceeded", message: "The plan limit on connected runtimes is reached" }); });
    const result = await step({ enrollment: { bind } as never });
    expect(result.done?.summary).toContain("Revoke the existing runtime in Settings");
    expect(result.done?.links.site).toContain("/settings/runtimes");
    expect(await readOnboardState(root)).toMatchObject({ step: "done" });
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
    expect(second.run?.argv).toEqual(["konteks-remote", "onboard", "--json"]);
    expect(await readOnboardState(root)).toMatchObject({ step: "email" });
  });

  it("ends the flow on an empty answer to the first task, not only on whitespace", async () => {
    await writeOnboardState(root, { step: "first_task", systemId: "sys-1", instanceId: "instance-1" } as never);
    const result = await step({}, "");
    expect(result.note).toBe("Ending here.");
    expect(await readOnboardState(root)).toMatchObject({ step: "done" });
  });
});
