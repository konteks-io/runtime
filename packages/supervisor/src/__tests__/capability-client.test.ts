import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, verifyInstanceProof, REMOTE_INSTANCE_PROOF_AUDIENCE } from "@konteks/remote-common";
import { CoreClient } from "../core/client.js";

const now = Date.parse("2026-09-06T12:00:00Z");
const args = { assignmentId: "assignment", attempt: 1, mcpCapabilityTokenRef: "kxcap_reference" };
const result = { token: "issued-capability", expiresAt: "2026-09-06T12:05:00Z", toolScopes: ["context.read"] };
function fixture(handler: (count: number, init?: RequestInit) => Promise<Response>) {
  const key = generateInstanceKey();
  let count = 0;
  const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => handler(++count, init));
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(now), key: () => key, credential: () => "lease", fetchFn });
  return { client, fetchFn, key };
}
const success = () => new Response(JSON.stringify(result));

describe("repeatable native capability delivery", () => {
  it("retries a lost response with the same reference and a fresh verified proof", async () => {
    const f = fixture(async count => { if (count === 1) throw new Error("connection lost"); return success(); });
    await expect(f.client.redeemCapabilityToken("instance", args)).resolves.toEqual({ mcpServer: { name: "konteks-platform", url: "https://core.example/mcp", headers: [{ name: "authorization", value: `Bearer ${result.token}` }] }, expiresAt: result.expiresAt });
    const bodies = f.fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].proof.nonce).not.toBe(bodies[1].proof.nonce);
    for (const body of bodies) {
      const { proof, ...unsigned } = body;
      expect(unsigned).toEqual({ instanceId: "instance", ...args });
      expect(verifyInstanceProof(f.key.publicKey, { method: "token_redeem", audience: REMOTE_INSTANCE_PROOF_AUDIENCE, subject: "instance", body: unsigned }, proof)).toBe(true);
    }
  });

  it("bounds transport retries to three attempts", async () => {
    const f = fixture(async () => { throw new Error("offline"); });
    await expect(f.client.redeemCapabilityToken("instance", args)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(f.fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each([403, 500])("does not retry explicit capability denial even at HTTP %s", async status => {
    const f = fixture(async () => new Response(JSON.stringify({ code: "capability_unavailable", message: "denied" }), { status }));
    await expect(f.client.redeemCapabilityToken("instance", args)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries an internal service failure, using bounded request timeouts", async () => {
    const f = fixture(async count => count < 3 ? new Response(JSON.stringify({ code: "temporarily_unavailable", message: "unavailable" }), { status: 500 }) : success());
    await expect(f.client.redeemCapabilityToken("instance", args)).resolves.toHaveProperty("mcpServer");
    expect(f.fetchFn).toHaveBeenCalledTimes(3);
    for (const [, init] of f.fetchFn.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries when the response body is lost after headers arrive", async () => {
    const f = fixture(async count => count === 1 ? new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("terminated")); } })) : success());
    await expect(f.client.redeemCapabilityToken("instance", args)).resolves.toHaveProperty("mcpServer");
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    { mcpServer: { name: "foreign", url: "https://elsewhere.example/mcp", headers: [] }, expiresAt: result.expiresAt },
    { ...result, toolScopes: undefined },
    { ...result, toolScopes: ["invented"] },
    { ...result, expiresAt: "2026-09-06T11:59:59Z" },
    { ...result, extra: true },
  ])("rejects noncanonical or expired responses without retry or token disclosure", async body => {
    const f = fixture(async () => new Response(JSON.stringify(body)));
    const outcome = await f.client.redeemCapabilityToken("instance", args).catch(error => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).not.toContain(result.token);
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("validates the entire request before contacting Core", async () => {
    const f = fixture(async () => success());
    await expect(f.client.redeemCapabilityToken("instance", { ...args, attempt: 0 })).rejects.toThrow();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it("rejects successful delivery arriving after the monotonic total budget", async () => {
    const f = fixture(async () => success());
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(30_001);
    try {
      await expect(f.client.redeemCapabilityToken("instance", args)).rejects.toMatchObject({ code: "capability_unavailable" });
      expect(f.fetchFn).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });

  it("does not expose or retry malformed JSON containing a token", async () => {
    const f = fixture(async () => new Response(`malformed ${result.token}`));
    const error = await f.client.redeemCapabilityToken("instance", args).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(result.token);
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not reinterpret an unknown server error as a transient authority decision", async () => {
    const f = fixture(async () => new Response(JSON.stringify({ code: "unrecognized_authority_denial" }), { status: 500 }));
    await expect(f.client.redeemCapabilityToken("instance", args)).rejects.toThrow();
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });
});
