import { describe, expect, it } from "vitest";
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
});
