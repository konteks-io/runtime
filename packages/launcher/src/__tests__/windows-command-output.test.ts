import { PassThrough } from "node:stream";
import { SECRET_CANARIES } from "@konteks/remote-common";
import { afterEach, describe, expect, it } from "vitest";
import { NativeServiceCommandError } from "../native/service.js";
import { setVerbose, verboseCommand } from "../verbose.js";

const refusal = "The legacy task does not launch this Konteks root; it was preserved.";
// The progress and Error stream shapes are from Windows PowerShell's actual
// registration failure; no machine paths or operator data are retained here.
const progress = '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>';
const document = (body: string) => `#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">${body}</Objs>`;
const error = (text: string) => `<S S="Error">${text}</S>`;
const command = { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive"] };

function service(stderr: string): string {
  return new NativeServiceCommandError("register", command, { code: 1, stderr }).excerpt;
}

function detailed(stderr: string): string {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
  setVerbose(true);
  verboseCommand(command, { code: 1, stderr }, 12, stream);
  stream.destroy();
  return text;
}

afterEach(() => setVerbose(false));

describe.each([
  { name: "service error", render: service },
  { name: "verbose diagnostics", render: detailed },
])("Windows command output: $name", ({ render }) => {
  it("shows the actual Error stream before a long module-progress prefix can consume the excerpt", () => {
    const text = render(document(progress.repeat(10) + error(`${refusal}_x000D__x000A_`) + error("At line:40 char:59_x000D__x000A_")));
    expect(text).toContain(refusal);
    expect(text).toContain("At line:40 char:59");
    expect(text).not.toContain("Preparing modules for first use");
    expect(text).not.toContain("<Objs");
    expect(text).not.toContain("_x000D_");
  });

  it("decodes XML entities and one-pass PowerShell string escapes, including literal escape text", () => {
    const text = render(document(error("Cannot open &quot;Ada &amp; O&apos;Brien&quot;: &#x4E2D;&#25991; _x005F_x0041_._x000D__x000A_Second line.")));
    expect(text).toContain('Cannot open "Ada & O\'Brien": 中文 _x0041_.');
    expect(text).toContain("Second line.");
    expect(text).not.toContain("&quot;");
    expect(text).not.toContain("_x005F_");
  });

  it("redacts decoded secrets before output bounds are applied", () => {
    const encoded = Array.from(SECRET_CANARIES.openAiKey, char => `_x${char.charCodeAt(0).toString(16).padStart(4, "0")}_`).join("");
    const text = render(document(error(`Failed with ${encoded}.`)));
    expect(text).toContain("Failed with [redacted].");
    expect(text).not.toContain(SECRET_CANARIES.openAiKey);
    expect(text).not.toContain(encoded);
  });

  it("strips decoded terminal controls without losing the error", () => {
    const text = render(document(error(`_x001B_[31m${refusal}_x001B_[0m_x0000_`)));
    expect(text).toContain(refusal);
    expect(text).not.toContain(String.fromCharCode(27));
    expect(text).not.toContain(String.fromCharCode(0));
    expect(text).not.toContain("[31m");
  });

  it("retains ordinary stderr and redacts it without requiring XML", () => {
    const text = render(`Access denied: ${SECRET_CANARIES.bearer}`);
    expect(text).toContain("Access denied:");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(SECRET_CANARIES.bearer);
  });

  it("keeps malformed XML as safe bounded text and never expands custom entities", () => {
    const malformed = '#< CLIXML\n<!DOCTYPE Objs [<!ENTITY local "expanded entity">]><Objs><S S="Error">DTD error: &local;</S>';
    expect(render(malformed)).not.toContain("DTD error: expanded entity");
    const text = render("plain failure " + "x".repeat(300_000));
    expect(text).toContain("plain failure");
    expect(text.length).toBeLessThan(2_200);
  });
});

it("keeps the service excerpt within its existing 300-character bound", () => {
  const text = service(document(error("Failure: " + "x".repeat(1_000))));
  expect(text).toMatch(/^Failure: /);
  expect(text).toHaveLength(300);
  expect(text.endsWith("…")).toBe(true);
});

it("leaves successful ordinary verbose output and exit reporting intact", () => {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
  setVerbose(true);
  verboseCommand(command, { code: 0, stdout: "ready\n", stderr: "" }, 12, stream);
  stream.destroy();
  expect(text).toContain("exited 0 after 12 ms");
  expect(text).toContain("stdout: ready");
  expect(text).not.toContain("stderr:");
});
