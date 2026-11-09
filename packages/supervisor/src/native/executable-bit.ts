import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Whether files under `directory` can hold an executable bit, probed the way
 * `git init` probes it: set the bit, then clear it, and read both back.
 *
 * A Windows file system has no executable bit; both Git for Windows and Node
 * report every file there as non-executable. With `core.fileMode` true on such
 * a host, Git reads every tracked 100755 file as a mode change to 100644, and a
 * delivery published those phantom changes (with whatever bytes the file held
 * on disk) for files the agent never meant to touch (11-08, runtime#182).
 */
export async function filesystemKeepsExecutableBit(directory: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  const probe = await mkdtemp(join(directory, ".executable-bit-"));
  try {
    const file = join(probe, "probe");
    await writeFile(file, "", { mode: 0o600 });
    await chmod(file, 0o700);
    const set = ((await lstat(file)).mode & 0o100) !== 0;
    await chmod(file, 0o600);
    const cleared = ((await lstat(file)).mode & 0o100) === 0;
    return set && cleared;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}
