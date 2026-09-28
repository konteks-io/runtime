import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { promptSecret } from "../prompt.js";

describe("hidden local prompt interruption", () => {
  it("rejects when the terminal sends Ctrl-C", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    const prompt = promptSecret({ label: "Test key", input, output: new PassThrough() });
    input.write("\x03");
    await expect(prompt).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });

  it("rejects when its input stream closes", async () => {
    const input = new PassThrough();
    const prompt = promptSecret({ label: "Test key", input, output: new PassThrough() });
    input.end();
    await expect(prompt).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
});
