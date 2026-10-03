import { copyFile, stat, truncate } from "node:fs/promises";
import { join } from "node:path";

/** The connector's own log in `<root>/logs`, where the OS keeps none (macOS launchd, the Windows task). */
const CONNECTOR_LOG_FILE = "connector.log";
const CONNECTOR_LOG_MAX_BYTES = 20 * 1024 * 1024;
const CHECK_EVERY_MS = 60 * 60_000;

/**
 * Keeps the log under its limit: the OS never rotates it, so past the limit its
 * contents move to `connector.log.1` (replacing the one before) and the file is
 * emptied in place, where the OS keeps appending. A missing log (the OS keeps
 * its own elsewhere) is left alone.
 */
export async function keepConnectorLogSmall(file: string, maxBytes = CONNECTOR_LOG_MAX_BYTES): Promise<boolean> {
  const size = await stat(file).then(info => info.size, () => 0);
  if (size <= maxBytes) return false;
  await copyFile(file, `${file}.1`);
  await truncate(file, 0);
  return true;
}

/**
 * Checks the log now and every hour while the connector runs; returns a stop.
 * Not on Windows: there cmd holds the log with a handle that writes at its own
 * offset rather than appending, so emptying it in place would leave a gap of
 * zeros as long as the old log; the task's host keeps it small before each
 * start instead (launcher service.ts).
 */
export function startConnectorLogKeeper(root: string, onError: (error: unknown) => void = () => undefined, platform: NodeJS.Platform = process.platform): () => void {
  if (platform === "win32") return () => undefined;
  const file = join(root, "logs", CONNECTOR_LOG_FILE);
  const check = () => { void keepConnectorLogSmall(file).catch(onError); };
  check();
  const timer = setInterval(check, CHECK_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
