import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { RemoteInstanceError, SECRET_CANARIES } from "@konteks/remote-common";
import { createOutput, describeAction } from "../output.js";
import { confirm, promptSecret } from "../prompt.js";

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let buffer = "";
  stream.on("data", (chunk: Buffer) => (buffer += chunk.toString("utf8")));
  return { stream, text: () => buffer };
}

describe("secure prompt", () => {
  it("reads the secret without echoing it and returns it only to the caller", async () => {
    const input = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true;
    const out = sink();
    const pending = promptSecret({ label: "Activation code", input, output: out.stream, minLength: 8 });
    input.write("s3cr3t-activation-code\n");
    const value = await pending;
    expect(value).toBe("s3cr3t-activation-code");
    expect(out.text()).toContain("Activation code (input hidden)");
    expect(out.text()).not.toContain("s3cr3t");
  });

  it("refuses a non-interactive stdin so a code can never arrive through a pipe by accident", async () => {
    const original = process.stdin;
    const fake = new PassThrough();
    (fake as unknown as { isTTY: boolean }).isTTY = false;
    Object.defineProperty(process, "stdin", { value: fake, configurable: true });
    try {
      await expect(promptSecret({ label: "Activation code" })).rejects.toBeInstanceOf(RemoteInstanceError);
    } finally {
      Object.defineProperty(process, "stdin", { value: original, configurable: true });
    }
  });

  it("rejects an implausible length", async () => {
    const input = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true;
    const pending = promptSecret({ label: "Activation code", input, output: sink().stream, minLength: 8 });
    input.write("short\n");
    await expect(pending).rejects.toMatchObject({ code: "activation_invalid" });
  });

  it("confirm never defaults to yes", async () => {
    const input = new PassThrough();
    const pending = confirm("Delete everything?", { input, output: sink().stream });
    input.write("\n");
    expect(await pending).toBe(false);
    const yes = new PassThrough();
    const pendingYes = confirm("Delete everything?", { input: yes, output: sink().stream });
    yes.write("yes\n");
    expect(await pendingYes).toBe(true);
  });
});

describe("output", () => {
  it("redacts canaries and secrets from every line, table, result, and error", () => {
    const out = sink();
    const err = sink();
    const output = createOutput({ json: false, stdout: out.stream, stderr: err.stream });
    const canary = Object.values(SECRET_CANARIES)[0] ?? "kxrp_canary";
    output.line(`token ${canary} here`);
    output.table([["lease", `Bearer ${canary}`]]);
    output.error(new RemoteInstanceError("temporarily_unavailable", `failed with ${canary}`, { recoveryActions: [{ kind: "run_doctor" }] }));
    expect(out.text()).not.toContain(canary);
    expect(err.text()).not.toContain(canary);
    expect(err.text()).toContain("konteks-remote doctor");
    const json = sink();
    const jsonOutput = createOutput({ json: true, stdout: json.stream, stderr: sink().stream });
    jsonOutput.result({ nested: { value: canary } });
    jsonOutput.line("not printed in json mode");
    expect(json.text()).not.toContain(canary);
    expect(json.text()).not.toContain("not printed");
    expect(JSON.parse(json.text())).toHaveProperty("nested");
  });

  it("maps every closed recovery action to an actionable sentence", () => {
    for (const kind of ["retry", "run_doctor", "login_agent", "update", "free_disk", "install_backend", "new_activation", "contact_support", "revoke_in_app", "reselect_runtime"]) {
      expect(describeAction({ kind, agentId: "codex" }).length).toBeGreaterThan(0);
    }
    expect(describeAction({ kind: "login_agent", agentId: "codex" })).toContain("auth login codex");
    expect(describeAction({ kind: "unknown_kind" })).toBe("");
  });
});
