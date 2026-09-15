import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOnboardStep } from "../native/onboard.js";
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
    const accepted = await step({ push: push as never }, "yes");
    expect(push).toHaveBeenCalledWith({
      repositoryPath: "/tmp/solo",
      remoteUrl: "https://git.konteks.test/acme/solo",
      branch: "trunk",
    });
    expect(accepted.note).toContain("Pushed trunk");
  });

  it("opens a project-management session with the person's sentence as its first turn", async () => {
    await writeOnboardState(root, {
      step: "first_task",
      systemId: "sys-1",
      instanceId: "instance-1",
      tenantId: "acme",
    } as never);
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: "session-9" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await step({ fetchFn: fetchFn as never }, "Add a coupon code to checkout");
    expect(result.note).toContain("first session is open");
    expect(calls[0]!.url).toBe("https://core.test/api/app/sessions");
    expect(calls[0]!.body).toMatchObject({
      mode: "project_management",
      system_id: "sys-1",
      runtimeTarget: { kind: "specific_instance", instanceId: "instance-1" },
    });
    expect(calls[1]!.url).toBe("https://core.test/api/app/sessions/session-9/messages");
    expect(calls[1]!.body).toMatchObject({ content: "Add a coupon code to checkout" });
    expect(await readOnboardState(root)).toMatchObject({
      step: "done",
      sessionUrl: "https://app.test/sessions/session-9",
    });
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
      sessionUrl: "https://app.test/sessions/session-9",
    } as never);
    const result = await step({});
    expect(result.done?.links).toMatchObject({
      site: "https://app.test",
      system: "https://app.test/systems/sys-1",
      session: "https://app.test/sessions/session-9",
    });
    expect(result.done?.summary).toContain("acme");
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
