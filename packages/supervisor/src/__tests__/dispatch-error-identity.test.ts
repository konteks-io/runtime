import { describe, expect, it } from "vitest";
import { z } from "zod";
import { dispatchErrorIdentity } from "../work/orchestrator.js";

describe("dispatch error identity", () => {
  it("keeps only the class and a system-style code, never message text", () => {
    const system = Object.assign(new Error("open /Users/secret/token failed"), { code: "ENOENT" });
    expect(dispatchErrorIdentity(system)).toEqual({ errorName: "Error", errorCode: "ENOENT" });
    expect(dispatchErrorIdentity(new TypeError("Cannot read properties of undefined"))).toEqual({ errorName: "TypeError" });
    expect(JSON.stringify(dispatchErrorIdentity(system))).not.toContain("secret");
  });

  it("drops codes and names that could carry free text", () => {
    expect(dispatchErrorIdentity(Object.assign(new Error("x"), { code: "bearer abc.def" }))).toEqual({ errorName: "Error" });
    expect(dispatchErrorIdentity("plain string")).toEqual({});
    expect(dispatchErrorIdentity({ code: 42 })).toEqual({});
  });

  it("names a schema refusal by code, field path and this connector's own refinement text, never a value", () => {
    const refined = z.object({ phase: z.string() }).superRefine((_value, context) => context.addIssue({ code: "custom", message: "Inconsistent local execution phase" }));
    const custom = refined.safeParse({ phase: "continued" });
    expect(dispatchErrorIdentity(custom.error)).toEqual({ errorName: "ZodError", schemaIssue: "custom: Inconsistent local execution phase" });
    const typed = z.object({ admission: z.object({ attempt: z.number() }) }).safeParse({ admission: { attempt: "secret-value" } });
    const identity = dispatchErrorIdentity(typed.error);
    expect(identity).toEqual({ errorName: "ZodError", schemaIssue: "invalid_type at admission.attempt" });
    expect(JSON.stringify(identity)).not.toContain("secret");
    const dynamicKey = z.record(z.string(), z.number()).safeParse({ "bearer abc": "x" });
    expect(dispatchErrorIdentity(dynamicKey.error).schemaIssue).toBe("invalid_type at ?");
  });
});
