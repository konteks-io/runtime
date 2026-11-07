import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

type Entry = { level: number; msg: string; workspaceId?: string; sessionId?: string; runtimeLogRepetition?: { suppressed: number }; [key: string]: unknown };
function logs(program: string): { entries: Entry[]; text: string } {
  const script = `import {createLogger} from ${JSON.stringify(new URL("../logger.ts", import.meta.url).href)};
    const logger=createLogger({name:"repetition-fixture",level:"debug",silent:false});
    ${program}`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  return { entries: result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Entry), text: result.stdout };
}

describe("structured error repetition", () => {
  it("emits the first error and a counted summary without keeping a finished process alive", () => {
    const result = logs(`for(let i=0;i<20;i++)logger.error({stage:"reconnect"},"connection refused");`);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ msg: "connection refused", stage: "reconnect" });
    expect(result.entries[1]).toMatchObject({ msg: "connection refused", runtimeLogRepetition: { suppressed: 19 } });
  });

  it("keeps workspace and session identities separate even when the error message is identical", () => {
    const result = logs(`for(let i=0;i<4;i++){logger.error({workspaceId:"alpha",sessionId:"one"},"refused");logger.error({workspaceId:"beta",sessionId:"two"},"refused");}logger.flush();`);
    expect(result.entries).toHaveLength(4);
    expect(result.entries.filter(entry => entry.runtimeLogRepetition)).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspaceId: "alpha", sessionId: "one", runtimeLogRepetition: expect.objectContaining({ suppressed: 3 }) }),
      expect.objectContaining({ workspaceId: "beta", sessionId: "two", runtimeLogRepetition: expect.objectContaining({ suppressed: 3 }) }),
    ]));
  });

  it("leaves informational and fatal entries immediate while counting repeated warnings and errors", () => {
    const result = logs(`for(let i=0;i<3;i++)logger.info("info");for(let i=0;i<2;i++)logger.fatal("fatal");for(let i=0;i<4;i++)logger.warn("warning");for(let i=0;i<5;i++)logger.error("error");logger.flush();`);
    expect(result.entries.filter(entry => entry.level === 30)).toHaveLength(3);
    expect(result.entries.filter(entry => entry.level === 60)).toHaveLength(2);
    expect(result.entries.filter(entry => entry.level === 40)).toHaveLength(2);
    expect(result.entries.filter(entry => entry.level === 50)).toHaveLength(2);
  });

  it("retains redaction in both the original error and its repetition summary", () => {
    const result = logs(`for(let i=0;i<4;i++)logger.error({token:"hidden",nested:{authorization:"hidden"}},"refused");logger.flush();`);
    expect(result.entries).toHaveLength(2);
    expect(result.text).not.toContain("hidden");
    for (const entry of result.entries) { expect(entry).not.toHaveProperty("pid"); expect(entry).not.toHaveProperty("hostname"); }
  });

  it("does not erase caller-provided timestamps or repetition metadata", () => {
    const result = logs(`for(let i=0;i<3;i++)logger.error({time:i},"explicit event time");for(let i=0;i<3;i++)logger.error({runtimeLogRepetition:{supplied:true}},"external metadata");logger.flush();`);
    expect(result.entries).toHaveLength(6);
  });

  it("keeps child logger bindings in repetition identity", () => {
    const result = logs(`const one=logger.child({workspaceId:"alpha",sessionId:"one"});const two=logger.child({workspaceId:"beta",sessionId:"two"});for(let i=0;i<3;i++){one.error("refused");two.error("refused");}logger.flush();`);
    expect(result.entries).toHaveLength(4);
    expect(result.entries.filter(entry => entry.runtimeLogRepetition).map(entry => entry.workspaceId).sort()).toEqual(["alpha", "beta"]);
  });

  it("flushes a ready logger's repetition count before explicit process exit", () => {
    const result = logs(`setImmediate(()=>{for(let i=0;i<5;i++)logger.error("refused");process.exit(0);});`);
    expect(result.entries).toHaveLength(2);
    // The first line's asynchronous write can still be in flight when the exit handler writes the summary synchronously.
    expect(result.entries.filter(entry => !entry.runtimeLogRepetition)).toHaveLength(1);
    expect(result.entries.find(entry => entry.runtimeLogRepetition)).toMatchObject({ runtimeLogRepetition: { suppressed: 4 } });
  });

  it("redacts child logger fields before they can enter a repetition summary", () => {
    const result = logs(`const child=logger.child({workspaceId:"alpha",token:"hidden",nested:{authorization:"hidden"}});for(let i=0;i<3;i++)child.error("refused");logger.flush();`);
    expect(result.entries).toHaveLength(2);
    expect(result.text).not.toContain("hidden");
    expect(result.entries.every(entry => entry.workspaceId === "alpha")).toBe(true);
  });
});
