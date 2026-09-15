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
    const question = await step({});
    expect(question.ask).toMatchObject({ kind: "confirm" });
    expect(question.ask?.question).toContain("acme-shop");

    const declined = await step({}, "no");
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
});
