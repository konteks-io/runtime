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
 * Not on Windows: the login host consumes the child's output pipe and owns
 * bounded log writes, including rotation. A second writer must not truncate
 * the file behind that host's retained stream position.
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
