import { defineConfig } from "vitest/config";

const characterize = process.env.REMOTE_INSTANCE_CHARACTERIZE === "1";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    env: {
      NODE_ENV: "test",
      LOG_SILENT: "true",
    },
    projects: [
      {
        test: {
          name: "unit",
          // A project does not inherit the root's test options: without this,
          // unit tests ran at Vitest's 5 s default and timed out on busy runners.
          testTimeout: 10_000,
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["packages/*/src/__characterization__/**"],
        },
      },
      {
        test: {
          name: "characterization",
          // Pinned bridges from an unpacked offline agent package and host
          // daemon behaviour. Opt-in: these need installed agents or a Linux host.
          include: characterize ? ["packages/*/src/__characterization__/**/*.test.ts"] : [],
          testTimeout: 600_000,
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
  },
});
