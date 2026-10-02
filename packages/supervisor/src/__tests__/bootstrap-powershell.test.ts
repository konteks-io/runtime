import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Windows bootstrap must load in Windows PowerShell 5.1. "$name:" inside a
 * double-quoted string parses as a drive-qualified variable, and one such
 * string ("v$BootstrapVersion: fetching…") made the whole script fail to load
 * on every Windows computer until 0.10.8. CI also parses it with pwsh.
 */
const script = readFileSync(fileURLToPath(new URL("../../../../bootstrap/install.ps1", import.meta.url)), "utf8");
const SCOPES = new Set(["env", "script", "global", "local", "private", "using", "variable", "function", "alias"]);

describe("bootstrap/install.ps1", () => {
  it("has no variable directly followed by a colon in a double-quoted string", () => {
    const offenders: string[] = [];
    for (const [index, line] of script.split("\n").entries()) {
      for (const quoted of line.match(/"(?:[^"`]|`.)*"/g) ?? []) {
        for (const match of quoted.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*):/g)) {
          if (!SCOPES.has(match[1]!.toLowerCase())) offenders.push(`line ${index + 1}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names TLS 1.3 only where the running .NET knows it", () => {
    expect(script).not.toMatch(/\[Net\.SecurityProtocolType\]::Tls13/);
  });
});
