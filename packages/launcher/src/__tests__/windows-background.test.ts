import { describe, expect, it } from "vitest";
import { nativeServiceDefinition } from "../native/service.js";

describe("Windows login background process", () => {
  const root = "C:\\Users\\Ada\\AppData\\Local\\konteks-remote";
  const definition = () => nativeServiceDefinition({ os: "windows", home: "C:\\Users\\Ada", root, executable: `${root}\\releases\\next\\konteks-connector.exe`, userId: "S-1-5-21-1-2-3-1001" });

  it("installs user login startup rather than registering a scheduled task", () => {
    const service = definition();
    expect(service.path).toBe(`${root}\\service.json`);
    expect(service.contents).not.toContain("<Task");
    expect(service.install.map(command => command.args.join(" ")).join("\n")).not.toContain("/Create");
  });

  it("has an explicit stop action even while its watchdog is between connector runs", () => {
    expect(definition()).toHaveProperty("windowsBackground", true);
    expect(definition()).toHaveProperty("legacyPath", `${root}\\service.xml`);
  });
});
