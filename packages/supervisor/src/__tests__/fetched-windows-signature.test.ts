import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execute }));
import { verifyFetchedSignature } from "../native/fetched-archive.js";

const certificateSha256 = "2029505d14baf18af60a0d1a7d8b56447db643b32faa849d4c08d2ab1ff3a4fd";
const signer = { kind: "authenticode" as const, certificateSha256 };
const answer = (text: string) => execute.mockImplementation((_file, _args, _options, callback) => callback(null, text, ""));

beforeEach(() => { execute.mockReset(); });

describe("fetched Windows agent publisher verification", () => {
  it("requires a valid OS signature and the pinned certificate fingerprint", async () => {
    answer(`Valid|${certificateSha256}`);
    await expect(verifyFetchedSignature("C:\\probe\\agent.exe", signer, "win32")).resolves.toBe(true);
    const script = Buffer.from(execute.mock.calls[0]![1].at(-1), "base64").toString("utf16le");
    expect(script).toContain("Get-AuthenticodeSignature");
    expect(script).toContain("SHA256");
    expect(script).toContain("RawData");
  });

  it("refuses another trusted publisher", async () => {
    answer(`Valid|${"f".repeat(64)}`);
    await expect(verifyFetchedSignature("C:\\probe\\agent.exe", signer, "win32")).resolves.toBe(false);
  });

  it("refuses an invalid signature even with Google's certificate", async () => {
    for (const status of ["HashMismatch", "NotTrusted", "UnknownError"]) {
      answer(`${status}|${certificateSha256}`);
      await expect(verifyFetchedSignature("C:\\probe\\agent.exe", signer, "win32")).resolves.toBe(false);
    }
  });

  it("fails closed when Windows cannot observe the signature", async () => {
    execute.mockImplementation((_file, _args, _options, callback) => callback(new Error("unavailable"), "", ""));
    await expect(verifyFetchedSignature("C:\\probe\\agent.exe", signer, "win32")).resolves.toBe(false);
  });

  it("never treats a Windows publisher as verified on another OS", async () => {
    await expect(verifyFetchedSignature("/probe/agent.exe", signer, "darwin")).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
