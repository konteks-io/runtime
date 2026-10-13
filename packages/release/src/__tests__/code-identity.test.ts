import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linuxSigningKeyId, parseLinuxSigningKeys, readCodeIdentity, signLinuxConnector } from "../code-identity.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "konteks-code-identity-")); roots.push(root);
  return root;
}

const result = (code: number, stderr = "", stdout = "") => ({ code, stdout, stderr });

describe("macOS connector identity", () => {
  const DEVELOPER_ID = 'identifier "dev.konteks.connector" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ABCDE12345';

  it("is the designated requirement of a Developer ID signature that verifies", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(result(0, "Executable=/x\nIdentifier=dev.konteks.connector\nAuthority=Developer ID Application: Konteks (ABCDE12345)\nTeamIdentifier=ABCDE12345\n"))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0, "Executable=/x\n", `designated => ${DEVELOPER_ID}\n`));
    await expect(readCodeIdentity("/x", "macos", { run })).resolves.toEqual({ signed: true, publisher: `macos ${DEVELOPER_ID}` });
    expect(run.mock.calls.map(call => call[1])).toEqual([["-dv", "--verbose=2", "/x"], ["--verify", "--strict", "/x"], ["-d", "-r-", "/x"]]);
  });

  it("is unsigned for an ad-hoc signature, whose requirement is the build's own hash, and for no signature", async () => {
    const adhoc = vi.fn().mockResolvedValue(result(0, "Identifier=konteks-remote-55554944\nCodeDirectory v=20400 flags=0x2(adhoc)\nSignature=adhoc\nTeamIdentifier=not set\n"));
    await expect(readCodeIdentity("/x", "macos", { run: adhoc })).resolves.toEqual({ signed: false });
    const none = vi.fn().mockResolvedValue(result(1, "/x: code object is not signed at all\n"));
    await expect(readCodeIdentity("/x", "macos", { run: none })).resolves.toEqual({ signed: false });
  });

  it("refuses a team signature that no longer verifies", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(result(0, "TeamIdentifier=ABCDE12345\n"))
      .mockResolvedValueOnce(result(1, "/x: invalid signature (code or signature have been modified)\n"));
    await expect(readCodeIdentity("/x", "macos", { run })).rejects.toMatchObject({ code: "bundle_untrusted" });
  });

  it.runIf(process.platform === "darwin")("reads a real ad-hoc signed executable as unsigned", async () => {
    const root = await scratch();
    const file = join(root, "konteks-connector");
    await copyFile("/usr/bin/true", file);
    execFileSync("codesign", ["--force", "--sign", "-", "--identifier", "dev.konteks.connector", file]);
    await expect(readCodeIdentity(file, "macos")).resolves.toEqual({ signed: false });
  });
});

describe("Windows connector identity", () => {
  const authenticode = (status: string, subject: string) => vi.fn().mockResolvedValue(result(0, "", JSON.stringify({ status, subject })));

  it("is the Authenticode signer of a valid signature", async () => {
    const run = authenticode("Valid", "CN=Konteks, O=Konteks, C=ID");
    await expect(readCodeIdentity("C:\\Users\\a'b\\konteks-connector.exe", "windows", { run })).resolves.toEqual({ signed: true, publisher: "windows CN=Konteks, O=Konteks, C=ID" });
    const script = Buffer.from(run.mock.calls[0]![1].at(-1), "base64").toString("utf16le");
    // The path is one quoted literal, its quote doubled.
    expect(script).toContain("-LiteralPath 'C:\\Users\\a''b\\konteks-connector.exe'");
  });

  it("is unsigned without a signature, and refuses a signature that does not verify", async () => {
    await expect(readCodeIdentity("C:\\x.exe", "windows", { run: authenticode("NotSigned", "") })).resolves.toEqual({ signed: false });
    await expect(readCodeIdentity("C:\\x.exe", "windows", { run: authenticode("HashMismatch", "CN=Konteks") })).rejects.toMatchObject({ code: "bundle_untrusted" });
    await expect(readCodeIdentity("C:\\x.exe", "windows", { run: vi.fn().mockResolvedValue(result(1)) })).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
});

describe("Linux connector identity", () => {
  const key = () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    return { privateKey, x: createPublicKey(privateKey).export({ format: "jwk" }).x! };
  };

  it("is the pinned key a detached signature verifies under", async () => {
    const root = await scratch();
    const file = join(root, "konteks-connector");
    await writeFile(file, "connector-bytes");
    const signing = key();
    await writeFile(`${file}.sig`, await signLinuxConnector(file, signing.privateKey));
    await expect(readCodeIdentity(file, "debian", { linuxKeys: [signing.x] })).resolves.toEqual({ signed: true, publisher: `debian ed25519:${linuxSigningKeyId(signing.x)}` });
  });

  it("is unsigned with no signature, or one from a key this build does not pin", async () => {
    const root = await scratch();
    const file = join(root, "konteks-connector");
    await writeFile(file, "connector-bytes");
    await expect(readCodeIdentity(file, "debian", { linuxKeys: [key().x] })).resolves.toEqual({ signed: false });
    await writeFile(`${file}.sig`, await signLinuxConnector(file, key().privateKey));
    await expect(readCodeIdentity(file, "debian", { linuxKeys: [key().x] })).resolves.toEqual({ signed: false });
  });

  it("refuses a pinned-key signature over other bytes, and a malformed signature document", async () => {
    const root = await scratch();
    const file = join(root, "konteks-connector");
    await writeFile(file, "connector-bytes");
    const signing = key();
    await writeFile(`${file}.sig`, await signLinuxConnector(file, signing.privateKey));
    await writeFile(file, "connector-bytes-changed");
    await expect(readCodeIdentity(file, "debian", { linuxKeys: [signing.x] })).rejects.toMatchObject({ code: "bundle_untrusted" });
    await writeFile(`${file}.sig`, "{}");
    await expect(readCodeIdentity(file, "debian", { linuxKeys: [signing.x] })).rejects.toMatchObject({ code: "bundle_untrusted" });
  });

  it("reads the pinned keys the release build bakes in", () => {
    const x = key().x;
    expect(parseLinuxSigningKeys(undefined)).toEqual([]);
    expect(parseLinuxSigningKeys(JSON.stringify([x]))).toEqual([x]);
    expect(() => parseLinuxSigningKeys(JSON.stringify(["not a key"]))).toThrow();
  });
});
