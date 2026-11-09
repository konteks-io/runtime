import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { redactText, writeSecretFile } from "@konteks/remote-common";
import { NATIVE_SHUTDOWN_RECEIPT_FILE } from "@konteks/remote-supervisor";
import { CONNECTOR_LOG_FILE } from "./service.js";

/**
 * The last time the background service could not be registered or started,
 * kept beside the supervisor's state so `doctor` and `support` can say it
 * while nothing is running to ask (a Windows start failed and doctor,
 * which asks the running connector, had nothing to show).
 */
const SERVICE_START_FAILURE_FILE = "service-start-failure.json";

interface ServiceStartFailure { at: string; message: string }

const failureFile = (root: string) => join(root, "supervisor", SERVICE_START_FAILURE_FILE);
export const connectorLogFile = (root: string) => join(root, "logs", CONNECTOR_LOG_FILE);

/** What this computer's own files say about the last exit and shutdown. */
export interface LocalServiceState {
  /** The supervisor's last controlled nonzero exit, when it recorded one. */
  lastExit: { reason: string; occurredAt: string } | null;
  /** The last shutdown boundary the supervisor reached, when it recorded one. */
  shutdownProgress: { phase: string; state: string; observedAt: string } | null;
  /** Whether the last shutdown reached its completion receipt. */
  shutdownComplete: boolean;
}

/** The supervisor's own markers, readable while its control socket is not. */
export async function readLocalServiceState(root: string): Promise<LocalServiceState> {
  const dataDir = join(root, "supervisor");
  const receipt = await readFile(join(dataDir, NATIVE_SHUTDOWN_RECEIPT_FILE), "utf8").catch(() => null);
  return {
    lastExit: await readLastExit(dataDir),
    shutdownProgress: await readShutdownProgress(dataDir),
    shutdownComplete: receipt !== null,
  };
}

async function readLastExit(dataDir: string): Promise<LocalServiceState["lastExit"]> {
  const value = await readRecord(join(dataDir, "last-exit.json"));
  if (!value || typeof value.reason !== "string" || typeof value.occurredAt !== "string") return null;
  return { reason: value.reason, occurredAt: value.occurredAt };
}

async function readShutdownProgress(dataDir: string): Promise<LocalServiceState["shutdownProgress"]> {
  const value = await readRecord(join(dataDir, "shutdown-progress.json"));
  if (!value || typeof value.phase !== "string" || typeof value.state !== "string" || typeof value.observedAt !== "string") return null;
  return { phase: value.phase, state: value.state, observedAt: value.observedAt };
}

/** A private JSON marker, or null when it is absent or not a JSON object. */
async function readRecord(path: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function recordServiceStartFailure(root: string, failure: ServiceStartFailure): Promise<void> {
  await writeSecretFile(failureFile(root), `${JSON.stringify({ at: failure.at, message: redactText(failure.message) })}\n`);
}

export async function clearServiceStartFailure(root: string): Promise<void> {
  await rm(failureFile(root), { force: true });
}

export async function readServiceStartFailure(root: string): Promise<ServiceStartFailure | null> {
  try {
    const value = JSON.parse(await readFile(failureFile(root), "utf8")) as { at?: unknown; message?: unknown };
    return typeof value.at === "string" && typeof value.message === "string" ? { at: value.at, message: value.message } : null;
  } catch {
    return null;
  }
}

/** The last lines of the connector log, redacted; null when there is none yet. */
export async function connectorLogTail(root: string, lines: number): Promise<string[] | null> {
  const text = await readFile(connectorLogFile(root), "utf8").catch(() => null);
  if (text === null) return null;
  return text.split(/\r?\n/).filter(line => line.trim().length > 0).slice(-lines).map(line => redactText(line).slice(0, 2_048));
}

/**
 * What `doctor` and `support` can say from this computer alone when the
 * connector is not running: that it is not, the last failed start, and the
 * log with its last lines.
 */
export async function localServiceReport(root: string, options: { tailLines: number }): Promise<{
  lines: string[];
  value: { running: false; lastStartFailure: ServiceStartFailure | null; log: string; logTail: string[] };
}> {
  const failure = await readServiceStartFailure(root);
  const tail = await connectorLogTail(root, options.tailLines);
  const log = connectorLogFile(root);
  const lines = [
    "Konteks is not running on this computer, so only these local checks ran.",
    ...(failure ? [`Last start (${failure.at}): ${failure.message}`] : []),
    tail === null ? `Connector log: ${log} (not written yet)` : `Connector log: ${log}`,
    ...(tail && tail.length > 0 ? ["Its last lines:", ...tail.map(line => `  ${line}`)] : []),
    "To start it: konteks-remote start (konteks-remote --verbose start shows every step).",
  ];
  return { lines, value: { running: false, lastStartFailure: failure, log, logTail: tail ?? [] } };
}
