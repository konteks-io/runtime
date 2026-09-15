import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlRequestSchema } from "@konteks/remote-common";
import { GitKeyStore, sshConfigPath } from "../onboard/git-keys.js";

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "konteks-git-keys-"));
}

function registrar() {
  const keys: Array<{ keyRef: string; title: string; fingerprint: string; createdAt: string; revokedAt?: string }> = [];
  return {
    keys,
    register: vi.fn(async (input: { publicKey: string; title: string }) => {
      keys.push({ keyRef: `key-${keys.length + 1}`, title: input.title, fingerprint: "SHA256:deadbeef", createdAt: "2026-09-14T00:00:00.000Z" });
      return { keyRef: `key-${keys.length}`, fingerprint: "SHA256:deadbeef", host: "git.konteks.io", user: "git", createdAt: "2026-09-14T00:00:00.000Z" };
    }),
    list: vi.fn(async () => keys),
    revoke: vi.fn(async (keyRef: string) => {
      const index = keys.findIndex(entry => entry.keyRef === keyRef);
      if (index >= 0) keys.splice(index, 1);
    }),
  };
}

/** A stand-in for ssh-keygen that writes the pair the real one would. */
function keygen(dir: string) {
  return vi.fn(async (request: { command: string; args: readonly string[] }) => {
    const target = request.args[request.args.indexOf("-f") + 1]!;
    await writeFile(target, "PRIVATE-KEY-MATERIAL\n", { mode: 0o600 });
    await writeFile(`${target}.pub`, "ssh-ed25519 AAAAC3Nza key\n", { mode: 0o644 });
    expect(target.startsWith(dir)).toBe(true);
    return { code: 0, signal: null, stdout: "", stderr: "" };
  });
}

describe("git key add", () => {
  it("registers only the public half and leaves the private one on the machine", async () => {
    const dir = await directory();
    const registry = registrar();
    const run = keygen(dir);
    const store = new GitKeyStore({ directory: dir, registrar: registry, run: run as never });

    const key = await store.add("laptop");

    expect(registry.register).toHaveBeenCalledWith({ publicKey: "ssh-ed25519 AAAAC3Nza key", title: "laptop" });
    expect(JSON.stringify(registry.register.mock.calls)).not.toContain("PRIVATE-KEY-MATERIAL");
    expect(key).toMatchObject({ keyRef: "key-1", title: "laptop", host: "git.konteks.io" });
    expect(await readFile(store.privateKeyPath, "utf8")).toContain("PRIVATE-KEY-MATERIAL");
  });

  it("reuses the key it already generated rather than minting a second one", async () => {
    const dir = await directory();
    const registry = registrar();
    const run = keygen(dir);
    const store = new GitKeyStore({ directory: dir, registrar: registry, run: run as never });

    await store.add("laptop");
    await store.add("laptop again");

    expect(run).toHaveBeenCalledTimes(1);
    expect(registry.register).toHaveBeenCalledTimes(2);
  });

  it("writes a stanza the person may include, and never edits their own ssh config", async () => {
    const dir = await directory();
    const store = new GitKeyStore({ directory: dir, registrar: registrar(), run: keygen(dir) as never });

    await store.add("laptop");

    const stanza = await readFile(sshConfigPath(dir), "utf8");
    expect(stanza).toContain("Host git.konteks.io");
    expect(stanza).toContain(`IdentityFile ${store.privateKeyPath}`);
    expect(stanza).toContain("IdentitiesOnly yes");
  });

  it("binds managed remotes to the registered key, and answers null before one exists", async () => {
    const dir = await directory();
    const store = new GitKeyStore({ directory: dir, registrar: registrar(), run: keygen(dir) as never });

    expect(await store.binding()).toBeNull();
    await store.add("laptop");
    expect(await store.binding()).toEqual({ host: "git.konteks.io", identityFile: store.privateKeyPath, user: "git" });
  });
});

describe("git key remove", () => {
  it("revokes in Core first, then drops the local half", async () => {
    const dir = await directory();
    const registry = registrar();
    const store = new GitKeyStore({ directory: dir, registrar: registry, run: keygen(dir) as never });
    const key = await store.add("laptop");

    await store.remove(key.keyRef);

    expect(registry.revoke).toHaveBeenCalledWith(key.keyRef);
    expect(await store.binding()).toBeNull();
    await expect(readFile(store.privateKeyPath, "utf8")).rejects.toThrow();
  });

  it("lists what Core holds, not what this machine remembers", async () => {
    const dir = await directory();
    const registry = registrar();
    const store = new GitKeyStore({ directory: dir, registrar: registry, run: keygen(dir) as never });
    await store.add("laptop");

    expect(await store.list()).toEqual(registry.keys);
    expect(registry.list).toHaveBeenCalled();
  });
});

describe("the control protocol carries no key material", () => {
  it("accepts the three key operations and nothing that could hold a key", () => {
    expect(ControlRequestSchema.parse({ op: "git.key.add", title: "laptop" })).toEqual({ op: "git.key.add", title: "laptop" });
    expect(ControlRequestSchema.parse({ op: "git.key.list" })).toEqual({ op: "git.key.list" });
    expect(ControlRequestSchema.parse({ op: "git.key.remove", keyRef: "key-1" })).toEqual({ op: "git.key.remove", keyRef: "key-1" });
    // There is deliberately no field a private key could be passed through.
    expect(ControlRequestSchema.safeParse({ op: "git.key.add", privateKey: "x" }).success).toBe(false);
  });
});
