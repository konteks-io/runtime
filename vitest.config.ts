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
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["packages/*/src/__characterization__/**"],
        },
      },
      {
        test: {
          name: "characterization",
          // Released images, pinned bridges, and Docker Compose behaviour.
          // Opt-in: these need Docker and network access.
          include: characterize ? ["packages/*/src/__characterization__/**/*.test.ts"] : [],
          testTimeout: 600_000,
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
  },
});
