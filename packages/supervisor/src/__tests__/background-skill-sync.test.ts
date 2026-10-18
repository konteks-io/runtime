import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("automatic Skill catalog synchronization", () => {
  it.each(["startup", "periodic"])("keeps the process alive when the %s catalog fetch rejects", (reason) => {
    const source = new URL("../supervisor.ts", import.meta.url).href;
    const script = `
      import { Supervisor } from ${JSON.stringify(source)};
      const reason = ${JSON.stringify(reason)};
      const timers = [];
      globalThis.setInterval = (callback, milliseconds) => {
        timers.push({ callback, milliseconds });
        return { unref() {} };
      };
      const supervisor = Object.create(Supervisor.prototype);
      Object.assign(supervisor, {
        mux: { tick() {} },
        cancellationReplay: null,
        syncPublishedLocalSkills: async () => {},
        refreshRuntimeSkillCatalog: async (trigger) => {
          if (trigger === reason) throw new Error("catalog-unavailable-fixture");
        },
      });
      supervisor.startChannelTimers();
      if (reason === "periodic") timers.find(timer => timer.milliseconds === 5 * 60_000).callback();
      await new Promise(resolve => setTimeout(resolve, 25));
      console.log("survived " + reason);
    `;
    const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TSX_DISABLE_CACHE: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`survived ${reason}`);
  });
});
