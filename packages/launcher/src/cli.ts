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

/** The customer executable has one architecture: a native BYOA connector. */
const LAUNCHER_VERSION = process.env.KONTEKS_LAUNCHER_VERSION ?? "0.1.0";

async function main(): Promise<void> {
  const { setupLocale } = await import("./setup-locale.js");
  setupLocale();
  // The Windows command the MSI installed runs the installed release's own
  // code: Program Files cannot be refreshed by the connector, so its
  // copy would otherwise run the first MSI's code forever.
  if (process.platform === "win32") {
    const [{ delegateToInstalledRelease }, { nativePaths }] = await Promise.all([import("./native/launcher-delegate.js"), import("./native/service.js")]);
    const code = await delegateToInstalledRelease({
      platform: process.platform, execPath: process.execPath, args: process.argv.slice(2), env: process.env, launcherVersion: LAUNCHER_VERSION,
      defaultRoot: () => nativePaths({ os: "windows" }).root,
      // The values build-launcher.mjs's entry filled in rather than found set.
      baked: (globalThis as { __konteksLauncherBakedEnv?: string[] }).__konteksLauncherBakedEnv ?? [],
    }).catch(() => null);
    if (code !== null) {
      process.exitCode = code;
      return;
    }
  }
  // Keep these imports after the warning filter above without introducing
  // top-level await. The release launcher is bundled as CommonJS because
  // Node's single-executable application entry point is a CommonJS script.
  const [{ createNativeProgram }, { nativeCliActions }, { createOutput }] =
    await Promise.all([
      import("./native/cli.js"),
      import("./native/commands.js"),
      import("./output.js"),
    ]);

  await createNativeProgram(nativeCliActions).parseAsync(process.argv).catch(
    (error: unknown) => {
      createOutput({ json: process.argv.includes("--json") }).error(error);
      process.exitCode = 1;
    },
  );
}

void main().catch(async (error: unknown) => {
  const { createOutput } = await import("./output.js");
  createOutput({ json: process.argv.includes("--json"), locale: process.env.KONTEKS_SETUP_LOCALE === "id" ? "id" : "en" }).error(error);
  process.exitCode = 1;
});
