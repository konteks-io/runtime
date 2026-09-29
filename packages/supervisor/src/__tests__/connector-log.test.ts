import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepConnectorLogSmall } from "../native/connector-log.js";

describe("the connector's own log (macOS keeps none)", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  it("moves a log past its limit to .1 and empties it in place; leaves a small or missing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "connector-log-")); dirs.push(dir);
    const file = join(dir, "connector.log");
    expect(await keepConnectorLogSmall(file, 10)).toBe(false);
    await writeFile(file, "short\n");
    expect(await keepConnectorLogSmall(file, 10)).toBe(false);
    await writeFile(file, "a line past the limit\n");
    expect(await keepConnectorLogSmall(file, 10)).toBe(true);
    expect(await readFile(`${file}.1`, "utf8")).toBe("a line past the limit\n");
    expect(await readFile(file, "utf8")).toBe("");
  });
});
