import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * The file only an MSI from 0.10.11 on installs next to `konteks-remote.exe`
 * (`packaging/windows/launcher.wxs`): that launcher runs the installed
 * release's own code. An older MSI's runs its own code for every
 * command, and no connector update can replace it under Program Files.
 */
export const WINDOWS_LAUNCHER_MARKER = "launcher.json";

/**
 * Whether the MSI's `konteks-remote` command runs this release's code
 * ("current") or its installer's old code ("older"); null where no MSI put a
 * command on this computer.
 */
export async function windowsInstalledLauncher(env: NodeJS.ProcessEnv = process.env): Promise<"current" | "older" | null> {
  if (!env.ProgramFiles) return null;
  const folder = join(env.ProgramFiles, "konteks-remote");
  const isFile = (path: string) => stat(path).then(info => info.isFile(), () => false);
  if (!await isFile(join(folder, "konteks-remote.exe"))) return null;
  return await isFile(join(folder, WINDOWS_LAUNCHER_MARKER)) ? "current" : "older";
}
