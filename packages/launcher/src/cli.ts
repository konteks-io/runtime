#!/usr/bin/env node
// Node flags its built-in SQLite, which the connector uses for its root lock,
// as experimental on every run. The person's agent reads this command's
// output, and a warning on every step is noise it has to explain away; drop
// that one warning, before anything loads it, and keep every other.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined);
  if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { createNativeProgram } = await import("./native/cli.js");
const { nativeCliActions } = await import("./native/commands.js");
const { createOutput } = await import("./output.js");

/** The customer executable has one architecture: a native BYOA connector. */
export const LAUNCHER_VERSION = process.env.KONTEKS_LAUNCHER_VERSION ?? "0.1.0";
createNativeProgram(nativeCliActions).parseAsync(process.argv).catch((error: unknown) => {
  createOutput({ json: process.argv.includes("--json") }).error(error);
  process.exitCode = 1;
});
