#!/usr/bin/env node
import { createNativeProgram } from "./native/cli.js";
import { nativeCliActions } from "./native/commands.js";
import { createOutput } from "./output.js";

/** The customer executable has one architecture: a native BYOA connector. */
export const LAUNCHER_VERSION = process.env.KONTEKS_LAUNCHER_VERSION ?? "0.1.0";
createNativeProgram(nativeCliActions).parseAsync(process.argv).catch((error: unknown) => {
  createOutput({ json: process.argv.includes("--json") }).error(error);
  process.exitCode = 1;
});
