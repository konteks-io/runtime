import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentScopeStore, INITIAL_SCOPE_STATE, applyIdentityObservation } from "../auth/scope-store.js";

describe("per-agent ownership scope (D101)", () => {
  const at = "2026-09-06T00:00:00Z";

  it("records an organization attestation only for a login with an identity", () => {
    const result = applyIdentityObservation(INITIAL_SCOPE_STATE, { fingerprint: "fp-1", organizationAttested: true, at, isLogin: true });
    expect(result.kind).toBe("attested");
    expect(result.state).toEqual({ accountScope: "organization", authIdentityFingerprint: "fp-1", scopeAttestedAt: at, lastLoginAt: at });
    const noIdentity = applyIdentityObservation(INITIAL_SCOPE_STATE, { fingerprint: null, organizationAttested: true, at, isLogin: true });
    expect(noIdentity.state.accountScope).toBe("personal");
  });

  it("resets to personal and reports agent_scope_reset when the fingerprint changes", () => {
    const attested = applyIdentityObservation(INITIAL_SCOPE_STATE, { fingerprint: "fp-1", organizationAttested: true, at, isLogin: true }).state;
    const switched = applyIdentityObservation(attested, { fingerprint: "fp-2", organizationAttested: false, at: "2026-09-07T00:00:00Z", isLogin: true });
    expect(switched.kind).toBe("reset");
    expect(switched.state).toMatchObject({ accountScope: "personal", authIdentityFingerprint: "fp-2", scopeAttestedAt: null });
  });

  it("resets when the agent logs out (fingerprint disappears)", () => {
    const attested = applyIdentityObservation(INITIAL_SCOPE_STATE, { fingerprint: "fp-1", organizationAttested: true, at, isLogin: true }).state;
    const loggedOut = applyIdentityObservation(attested, { fingerprint: null, organizationAttested: false, at, isLogin: false });
    expect(loggedOut.kind).toBe("reset");
    expect(loggedOut.state.accountScope).toBe("personal");
  });

  it("keeps the attestation across a probe that sees the same fingerprint", () => {
    const attested = applyIdentityObservation(INITIAL_SCOPE_STATE, { fingerprint: "fp-1", organizationAttested: true, at, isLogin: true }).state;
    const same = applyIdentityObservation(attested, { fingerprint: "fp-1", organizationAttested: false, at: "later", isLogin: false });
    expect(same.kind).toBe("unchanged");
    expect(same.state.accountScope).toBe("organization");
  });

  it("re-attestation after a reset restores organization scope", () => {
    const attested = applyIdentityObservation(INITIAL_SCOPE_STATE, { fingerprint: "fp-1", organizationAttested: true, at, isLogin: true }).state;
    const reset = applyIdentityObservation(attested, { fingerprint: "fp-2", organizationAttested: false, at, isLogin: true }).state;
    const again = applyIdentityObservation(reset, { fingerprint: "fp-2", organizationAttested: true, at, isLogin: true });
    expect(again.kind).toBe("attested");
    expect(again.state.accountScope).toBe("organization");
  });
});

describe("scope store persistence", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kr-scope-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to personal and round-trips through the credential volume", async () => {
    const store = new AgentScopeStore(dir);
    expect(await store.read()).toEqual(INITIAL_SCOPE_STATE);
    const state = { accountScope: "organization" as const, authIdentityFingerprint: "fp", scopeAttestedAt: "2026-09-06T00:00:00Z", lastLoginAt: "2026-09-06T00:00:00Z" };
    await store.write(state);
    expect(await store.read()).toEqual(state);
  });
});
