import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepConnectorLogSmall, startConnectorLogKeeper } from "../native/connector-log.js";

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

  it("leaves a Windows log alone, whose writer does not append (D129)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "connector-log-")); dirs.push(dir);
    await mkdir(join(dir, "logs"));
    const file = join(dir, "logs", "connector.log");
    await writeFile(file, "x".repeat(21 * 1024 * 1024));
    startConnectorLogKeeper(dir, () => undefined, "win32")();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await stat(file)).size).toBe(21 * 1024 * 1024);
    await expect(stat(`${file}.1`)).rejects.toThrow();
  });
});
