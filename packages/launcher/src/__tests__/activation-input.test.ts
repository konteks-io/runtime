import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readActivationCodePipe } from "../native/activation-input.js";

describe("explicit activation code pipe", () => {
  it.each(["one-time-value", "one-time-value\n", "one-time-value\r\n"])("reads one code after EOF without terminal output", async value => {
    await expect(readActivationCodePipe(Readable.from([value]))).resolves.toBe("one-time-value");
  });
  it.each(["", "short", "one-time-value\nsecond-value", "one-time\0value", "one-time\u001bvalue", "x".repeat(4_097)])("refuses invalid input without including it in the error", async value => {
    await expect(readActivationCodePipe(Readable.from([value]))).rejects.toMatchObject({ code: "activation_invalid" });
  });
  it("refuses an echoing terminal without reading it", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    await expect(readActivationCodePipe(input)).rejects.toMatchObject({ code: "activation_invalid" });
    expect(input.readableFlowing).toBeNull();
    input.destroy();
  });
  it("caps input before EOF", async () => {
    const input = new PassThrough();
    const result = readActivationCodePipe(input);
    input.write(Buffer.alloc(4_099, 120));
    await expect(result).rejects.toMatchObject({ code: "activation_invalid" });
    expect(input.destroyed).toBe(true);
  });
  it("bounds an unclosed pipe without exposing stream errors", async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      const result = readActivationCodePipe(input);
      const rejected = expect(result).rejects.toMatchObject({ code: "activation_invalid" });
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(input.destroyed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("does not disclose a producer's error message", async () => {
    const input = new PassThrough();
    const result = readActivationCodePipe(input);
    input.destroy(new Error("private-producer-data"));
    await expect(result).rejects.not.toThrow("private-producer-data");
  });
});
