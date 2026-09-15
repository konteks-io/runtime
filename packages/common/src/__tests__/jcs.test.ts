import { describe, expect, it } from "vitest";
import { canonicalize, withoutMembers, PROOF_MEMBERS } from "../jcs.js";

describe("RFC 8785 canonicalization", () => {
  it("sorts members by UTF-16 code unit and drops whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], "é": 2, A: 3 })).toBe(
      '{"A":3,"a":[true,null,"x"],"b":1,"é":2}',
    );
  });

  it("serializes numbers like ES Number::toString", () => {
    expect(canonicalize({ n: 1e21, m: 0.000001, k: -0, j: 10 })).toBe(
      '{"j":10,"k":0,"m":0.000001,"n":1e+21}',
    );
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it("omits undefined members so optional wire fields do not change a digest", () => {
    expect(canonicalize({ a: 1, b: undefined as unknown as null })).toBe('{"a":1}');
  });

  it("strips every PROOF_MEMBERS entry regardless of which proof is being produced", () => {
    const body = {
      grantId: "g",
      replicaAuth: { nonce: "n" },
      proof: { s: "x" },
      keyProof: {},
      relayAuth: {},
    };
    expect(withoutMembers(body, PROOF_MEMBERS)).toEqual({ grantId: "g" });
  });
});
