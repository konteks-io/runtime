import { createHash, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
// Cross-repository interoperability proof: the actual Core producer beside the
// actual connector consumer. It runs only next to a Core checkout; the public
// repository ships without one, so the proof is skipped there, never faked.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const CORE_SIGNING_SERVICE = fileURLToPath(new URL("../../../../../core/plugins/remote-instance-backend/src/services/CoreControlSigningService.ts", import.meta.url));
const coreSigning: { CoreControlSigningService: new (options: never) => { sign(payload: Record<string, unknown>): Promise<unknown> } } | null =
  existsSync(CORE_SIGNING_SERVICE) ? await import(CORE_SIGNING_SERVICE) : null;

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
function fixture() {
  const keys = buildReleaseFixture();
  const entries = [
    {
      path: "README.md",
      mode: 0o600,
      sizeBytes: 5,
      digest: `sha256:${createHash("sha256").update("hello").digest("hex")}`,
      contentBase64: Buffer.from("hello").toString("base64"),
    },
  ];
  const tree = {
    format: "konteks-file-tree-v1",
    treeDigest: computeRemoteFileTreeDigest(entries),
    entries,
  };
  const source = {
    version: 1,
    transferId: "source",
    binding,
    direction: "to_runtime",
    purpose: "source",
    revision: "revision",
    artifactRef: "artifact:source",
    treeDigest: tree.treeDigest,
    sizeBytes: 5,
    fileCount: 1,
    expiresAt: "2026-09-06T02:00:00Z",
  };
  const catalog = { version: 1, binding, skills: [] };
  const selection = {
    version: 1,
    binding,
    claimId: "claim",
    source,
    skills: { ...catalog, catalogDigest: computeRemoteSkillCatalogDigest(catalog) },
  };
  const unsigned = {
    type: "assignment_inputs",
    instanceId: "instance",
    selection,
    selectionDigest: computeRemoteAssignmentInputSelectionDigest(selection),
    issuedAt: "2026-09-06T01:00:00Z",
    expiresAt: "2026-09-06T01:05:00Z",
  };
  const envelope = {
    ...unsigned,
    signature: sign(null, remoteControlSigningBytes(unsigned), keys.privateKey).toString(
      "base64url",
    ),
  };
  const clock = new FixedClock(now);
  const response = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetchFn = vi.fn(async (url: string | URL, _init?: RequestInit) =>
    response(String(url).endsWith("/prepare") ? envelope : tree),
  );
  const options = {
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
    retrySleep: async () => undefined,
  };
  return { keys, tree, selection, envelope, fetchFn, clock, options, response };
}

describe("native claim-scoped input client", () => {
  it("fetches an exact signed repository bundle without receiving a VCS credential or URL", async () => {
    const f = fixture();
    const repository = {
      version: 1 as const,
      transport: "core_git_bundle_v1" as const,
      repositoryId: "https://gitea.example/acme/online-store",
      revision: "b".repeat(40),
      capabilityId: "repository-fetch",
      expiresAt: "2026-09-06T02:00:00Z",
    };
    const selection = {
      ...f.selection,
      source: { ...f.selection.source, revision: repository.revision },
      repository,
      repositoryWorkspace: { mode: "preserve" as const },
    };
    const unsigned = {
      type: "assignment_inputs" as const,
      instanceId: "instance",
      selection,
      selectionDigest: computeRemoteAssignmentInputSelectionDigest(selection),
      issuedAt: "2026-09-06T01:00:00Z",
      expiresAt: "2026-09-06T01:05:00Z",
    };
    const envelope = {
      ...unsigned,
      signature: sign(null, remoteControlSigningBytes(unsigned), f.keys.privateKey).toString("base64url"),
    };
    const bundle = Buffer.from("git bundle bytes");
    f.fetchFn.mockResolvedValue(new Response(bundle, {
      headers: { "content-type": "application/x-git-bundle", "x-konteks-revision": repository.revision },
    }));
    const result = await new NativeInputClient(f.options).fetchRepository(
      assignment,
      "claim",
      envelope,
      ["c".repeat(40)],
    );
    expect(Buffer.from(result)).toEqual(bundle);
    const [url, init] = f.fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/assignments/assignment/inputs/fetch-repository");
    expect(JSON.parse(String(init?.body))).toEqual({
      attempt: 1,
      claimId: "claim",
      selectionDigest: unsigned.selectionDigest,
      capabilityId: "repository-fetch",
      repositoryId: repository.repositoryId,
      revision: repository.revision,
      haveRevisions: ["c".repeat(40)],
    });
    expect(String(init?.body)).not.toMatch(/token|password|cloneUrl/i);
  });
  it("reauthorizes once when Core rejects a lease renewed during input preparation", async () => {
    const f = fixture();
    let lease: string | null = "old-lease";
    f.fetchFn.mockImplementationOnce(async () => {
      lease = "renewed-lease";
      return new Response(null, { status: 422 });
    });
    await expect(
      new NativeInputClient({ ...f.options, credential: () => lease }).prepare(assignment, "claim"),
    ).resolves.toEqual(f.envelope);
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
    expect(
      f.fetchFn.mock.calls.map(
        (call) => (call[1]?.headers as Record<string, string>).authorization,
      ),
    ).toEqual(["Bearer old-lease", "Bearer renewed-lease"]);
    expect(f.fetchFn.mock.calls[0]![1]?.body).toBe(f.fetchFn.mock.calls[1]![1]?.body);
  });
  it("waits briefly for a heartbeat renewal adopted just after Core refused the old lease", async () => {
    const f = fixture();
    let lease = "old-lease";
    f.fetchFn.mockImplementationOnce(async () => {
      setTimeout(() => {
        lease = "renewed-lease";
      }, 250);
      return new Response(null, { status: 422 });
    });
    await expect(
      new NativeInputClient({ ...f.options, credential: () => lease }).prepare(assignment, "claim"),
    ).resolves.toEqual(f.envelope);
    expect(
      f.fetchFn.mock.calls.map(
        (call) => (call[1]?.headers as Record<string, string>).authorization,
      ),
    ).toEqual(["Bearer old-lease", "Bearer renewed-lease"]);
  });
  it.each(["old-lease", null])(
    "does not retry rejected inputs without a replacement credential (%s)",
    async (replacement) => {
      const f = fixture();
      let lease: string | null = "old-lease";
      f.fetchFn.mockImplementation(async () => {
        lease = replacement;
        return new Response(null, { status: 422 });
      });
      await expect(
        new NativeInputClient({
          ...f.options,
          renewalWaitMs: 300,
          credential: () => lease,
        }).prepare(assignment, "claim"),
      ).rejects.toThrow();
      expect(f.fetchFn).toHaveBeenCalledOnce();
    },
  );
  it("bounds repeated renewal rejection to two requests", async () => {
    const f = fixture();
    let revision = 0;
    f.fetchFn.mockImplementation(async () => {
      revision += 1;
      return new Response(null, { status: 422 });
    });
    await expect(
      new NativeInputClient({
        ...f.options,
        renewalWaitMs: 300,
        credential: () => `lease-${revision}`,
      }).prepare(assignment, "claim"),
    ).rejects.toThrow();
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
  });
  it("keeps each retry attempt deadline bounded across credential renewal", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let lease = "old-lease";
      f.fetchFn
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20_000));
          lease = "renewed-lease";
          return new Response(null, { status: 422 });
        })
        .mockImplementation(() => new Promise(() => {}));
      const outcome = new NativeInputClient({ ...f.options, credential: () => lease, retrySleep: async () => undefined })
        .prepare(assignment, "claim")
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(401_000);
      expect((await outcome).code).toBe("capability_unavailable");
      // The first outer attempt safely reauthorizes once after the lease
      // rotates, followed by the remaining three transient retries.
      expect(f.fetchFn).toHaveBeenCalledTimes(5);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("binds a planning intake to its exact immutable input digest, not an absent generic revision", async () => {
    const f = fixture();
    const inputDigest = "a".repeat(64);
    const planning = {
      ...assignment,
      kind: "planning",
      taskId: "plan",
      agentRoute: { ...assignment.agentRoute, requiredRole: "planner" },
      source: {
        kind: "planning_intake",
        portability: "portable_before_claim",
        intakeRef: "intake",
        planId: "plan",
        publicSessionId: "session",
        inputDigest,
      },
    } as RemoteWorkAssignment;

    await expect(new NativeInputClient(f.options).prepare(planning, "claim")).rejects.toMatchObject(
      { code: "capability_unavailable" },
    );

    const selection = { ...f.selection, source: { ...f.selection.source, revision: inputDigest } };
    const unsigned = {
      type: "assignment_inputs" as const,
      instanceId: "instance",
      selection,
      selectionDigest: computeRemoteAssignmentInputSelectionDigest(selection),
      issuedAt: "2026-09-06T01:00:00Z",
      expiresAt: "2026-09-06T01:05:00Z",
    };
    f.fetchFn.mockResolvedValue(
      f.response({
        ...unsigned,
        signature: sign(null, remoteControlSigningBytes(unsigned), f.keys.privateKey).toString(
          "base64url",
        ),
      }),
    );
    await expect(
      new NativeInputClient(f.options).prepare(planning, "claim"),
    ).resolves.toMatchObject({ selection: { source: { revision: inputDigest } } });
  });

  it.skipIf(coreSigning === null)("accepts an input envelope signed by the actual Core control producer", async () => {
    const f = fixture();
    const key = { keyId: f.keys.keyId, publicKeyJwk: f.keys.root.publicKeyJwk };
    const producer = new coreSigning!.CoreControlSigningService({
      cluster: "local-test",
      key,
      vault: {
        retrieveSecret: async () => ({
          value: {
            keyId: key.keyId,
            key: f.keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
          },
        }),
      },
    });
    const { signature: _, ...unsigned } = f.envelope;
    const signature = await producer.sign(unsigned);
    f.fetchFn.mockResolvedValue(f.response({ ...unsigned, signature }));
    expect(
      (await new NativeInputClient(f.options).prepare(assignment, "claim")).selectionDigest,
    ).toBe(f.envelope.selectionDigest);
  });
  it("clears its deadline when the fetch adapter throws synchronously", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.fetchFn.mockImplementation(() => {
        throw new Error("transport unavailable");
      });
      await expect(new NativeInputClient(f.options).prepare(assignment, "claim")).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds a stalled response body and cancels it at the request deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(),
        cancel = vi.fn();
      f.fetchFn.mockImplementation(async () =>
        new Response(new ReadableStream({ start() {}, cancel }), {
          headers: { "content-type": "application/json" },
        }),
      );
      const outcome = new NativeInputClient(f.options)
        .prepare(assignment, "claim")
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(401_000);
      expect((await outcome).code).toBe("capability_unavailable");
      expect(cancel).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("checks authorization expiry again after receiving a tree", async () => {
    const f = fixture(),
      client = new NativeInputClient(f.options);
    const authorized = await client.prepare(assignment, "claim");
    f.fetchFn.mockImplementation(async () => {
      f.clock.advance(300_001);
      return f.response(f.tree);
    });
    await expect(client.read(assignment, "claim", authorized, "source")).rejects.toThrow();
  });
  it("rejects a correctly signed envelope issued in the future", async () => {
    const f = fixture();
    const { signature: _, ...unsigned } = { ...f.envelope, issuedAt: "2026-09-06T01:01:00Z" };
    f.fetchFn.mockResolvedValue(
      f.response({
        ...unsigned,
        signature: sign(null, remoteControlSigningBytes(unsigned), f.keys.privateKey).toString(
          "base64url",
        ),
      }),
    );
    await expect(
      new NativeInputClient(f.options).prepare(assignment, "claim"),
    ).rejects.toMatchObject({
      code: "capability_unavailable",
      diagnostic: "envelope_issued_future",
    });
  });
  it("accepts a delivery envelope within HTTP Date clock quantization", async () => {
    const f = fixture();
    const delivery = {
      ...assignment,
      kind: "delivery",
      correlationId: "invocation",
      agentRoute: { ...assignment.agentRoute, requiredRole: "generator" },
      source: {
        kind: "harness_delivery",
        portability: "instance_bound",
        ownerInstanceId: "instance",
        executionSessionId: "session",
        repositoryId: "https://git.example.com/acme/store",
        modelBinding: { canonicalProviderId: "openai", canonicalModelId: "model-a" },
        turn: { invocationId: "invocation", dispatchGeneration: 0 },
      },
    } as RemoteWorkAssignment;
    const clock = new FixedClock(now - 999);

    await expect(
      new NativeInputClient({ ...f.options, clock }).prepare(delivery, "claim"),
    ).resolves.toEqual(f.envelope);
  });
  it("preserves a safe closed verification diagnostic through the exclusive guard", async () => {
    const f = fixture();
    f.fetchFn.mockResolvedValue(f.response({ ...f.envelope, signature: "A".repeat(86) }));
    const error = await new NativeInputClient(f.options)
      .prepare(assignment, "claim")
      .catch((value) => value);
    expect(error).toMatchObject({
      code: "capability_unavailable",
      diagnostic: "envelope_signature_invalid",
    });
    expect(error.cause).toBeUndefined();
  });
  it("distinguishes a malformed JSON transport response without exposing its body", async () => {
    const f = fixture();
    f.fetchFn.mockResolvedValue(
      new Response('{"private":"unterminated', { headers: { "content-type": "application/json" } }),
    );
    const error = await new NativeInputClient(f.options)
      .prepare(assignment, "claim")
      .catch((value) => value);
    expect(error).toMatchObject({
      code: "capability_unavailable",
      diagnostic: "response_decode_invalid",
    });
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain("unterminated");
  });
  it("verifies signed input selection and reads only a selected tree over fixed authenticated routes", async () => {
    const f = fixture(),
      client = new NativeInputClient(f.options);
    const authorized = await client.prepare(assignment, "claim");
    expect(authorized).toEqual(f.envelope);
    expect(
      await client.read(assignment, "claim", authorized, authorized.selection.source.transferId),
    ).toEqual(f.tree);
    const [url, init] = f.fetchFn.mock.calls[1]!;
    expect(String(url)).toBe(
      "https://core.example/api/remote-instances/internal/remote-instances/instance/assignments/assignment/inputs/read",
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: { authorization: "Bearer test-lease" },
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      attempt: 1,
      claimId: "claim",
      selectionDigest: authorized.selectionDigest,
      transferId: "source",
    });
    expect(String(init?.body)).not.toContain("artifact:source");
    await client.prepare(assignment, "claim", authorized.selectionDigest);
    expect(JSON.parse(String(f.fetchFn.mock.calls[2]![1]?.body)).selectionDigest).toBe(
      authorized.selectionDigest,
    );
  });
  it.each(["workspaceId", "instanceId", "id", "attempt"])(
    "refuses a signed selection for another assignment %s",
    async (field) => {
      const f = fixture();
      await expect(
        new NativeInputClient(f.options).prepare(
          { ...assignment, [field]: field === "attempt" ? 2 : "other" },
          "claim",
        ),
      ).rejects.toThrow();
    },
  );
  it("rejects other claims, conversation sessions, unselected artifacts and substituted pinned digests", async () => {
    const f = fixture(),
      client = new NativeInputClient(f.options);
    await expect(client.prepare(assignment, "other")).rejects.toThrow();
    await expect(
      client.prepare(
        {
          ...assignment,
          source: { ...assignment.source, sessionId: "other" },
        } as RemoteWorkAssignment,
        "claim",
      ),
    ).rejects.toThrow();
    await expect(client.prepare(assignment, "claim", `sha256:${"f".repeat(64)}`)).rejects.toThrow();
    const authorized = await client.prepare(assignment, "claim");
    f.fetchFn.mockClear();
    await expect(client.read(assignment, "claim", authorized, "unselected")).rejects.toThrow();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it("rejects forged, expired and future-dated envelopes without staging bytes", async () => {
    for (const patch of [
      { signature: "A".repeat(86) },
      { issuedAt: "2026-09-06T01:01:00Z" },
      { expiresAt: "2026-09-06T00:59:00Z" },
    ]) {
      const f = fixture();
      f.fetchFn.mockResolvedValue(f.response({ ...f.envelope, ...patch }));
      await expect(
        new NativeInputClient(f.options).prepare(assignment, "claim"),
      ).rejects.toMatchObject({ code: "capability_unavailable" });
    }
  });
  it("checks tree bytes and refuses a missing runtime lease", async () => {
    const f = fixture(),
      client = new NativeInputClient(f.options);
    const authorized = await client.prepare(assignment, "claim");
    f.fetchFn.mockResolvedValue(f.response({ ...f.tree, entries: [] }));
    await expect(client.read(assignment, "claim", authorized, "source")).rejects.toThrow();
    f.fetchFn.mockClear();
    await expect(
      new NativeInputClient({ ...f.options, credential: () => null }).prepare(assignment, "claim"),
    ).rejects.toThrow();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it.each(["html", "redirect", "oversized", "error"])(
    "refuses %s responses without echoing their body",
    async (kind) => {
      const f = fixture();
      const secret = "private organization source contents";
      const response =
        kind === "oversized"
          ? new Response("x".repeat(256 * 1024 + 1), {
              headers: { "content-type": "application/json" },
            })
          : kind === "redirect"
            ? new Response(null, {
                status: 302,
                headers: { location: "https://elsewhere.example" },
              })
            : new Response(secret, {
                status: kind === "error" ? 403 : 200,
                headers: { "content-type": kind === "html" ? "text/html" : "application/json" },
              });
      f.fetchFn.mockResolvedValue(response);
      const result = await new NativeInputClient({ ...f.options, renewalWaitMs: 1 })
        .prepare(assignment, "claim")
        .catch((error) => error);
      expect(result.code).toBe("capability_unavailable");
      expect(String(result)).not.toContain(secret);
      expect(result.cause).toBeUndefined();
    },
  );
  it("does not permit concurrent input requests on one preparer", async () => {
    const f = fixture();
    let respond!: (value: Response) => void;
    f.fetchFn.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const client = new NativeInputClient(f.options);
    const first = client.prepare(assignment, "claim");
    await expect(client.prepare(assignment, "claim")).rejects.toThrow();
    respond(f.response(f.envelope));
    await expect(first).resolves.toEqual(f.envelope);
  });
});
