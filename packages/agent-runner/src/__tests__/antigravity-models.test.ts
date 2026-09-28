import { describe, expect, it } from "vitest";
import { recogniseNativeModel } from "@konteks/backstage-plugin-common/known-models";
import { MAX_OFFERED_MODEL_VALUES, exactSelect } from "../bridge/model-capability.js";

/**
 * Google Antigravity's models come from its `model` select (CP0: 14 with an
 * API key; 11 under the Gemini Enterprise Plus licence, CP2 live) and are
 * recognised by packages' `recogniseNativeModel('antigravity', …)` (CP5).
 */
const ENTERPRISE = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
  "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low", "gemini-3.1-pro-low", "gemini-3.1-pro-high"];

describe("Google Antigravity's model select", () => {
  it("reports every model its licence offers, each recognised as a Gemini model", () => {
    const options = ENTERPRISE.map(value => ({ value, name: value }));
    const result = exactSelect({ id: "model", name: "Model", type: "select", currentValue: "gemini-3.8-flash-high", options } as never, "antigravity");
    expect(result.offeredValues).toEqual(ENTERPRISE);
    expect(result.currentValue).toBe("gemini-3.8-flash-high");
    for (const value of ENTERPRISE) expect(recogniseNativeModel("antigravity", value).status, value).toBe("known");
    expect(recogniseNativeModel("antigravity", "gemini-3.8-flash-high")).toMatchObject({ effort: "high" });
  });

  it("above the wire bound keeps the known Gemini models first and the current one (KM6)", () => {
    const unknown = Array.from({ length: 140 }, (_value, index) => ({ value: `org-model-${index}`, name: `Org model ${index}` }));
    const gemini = ENTERPRISE.map(value => ({ value, name: value }));
    const result = exactSelect({ id: "model", name: "Model", type: "select", currentValue: "org-model-139", options: [...unknown, ...gemini] } as never, "antigravity");
    expect(result.offeredValues).toHaveLength(MAX_OFFERED_MODEL_VALUES);
    expect(result.offeredValues).toEqual(expect.arrayContaining(["org-model-139", ...ENTERPRISE]));
  });
});
