import { findAgentBridge, type NativeDownloadProgress } from "@konteks/remote-release";
import type { Output } from "./output.js";
import { setupWords } from "./setup-locale.js";

const MIB = 1024 * 1024;
const WAITING_MS = 5_000;

function estimateTime(output: Output, seconds: number): string {
  if (seconds < 60) return setupWords(output, "downloadSeconds", { seconds });
  return setupWords(output, "downloadMinutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

function downloadName(output: Output, agentId: string | undefined): string {
  if (!agentId) return setupWords(output, "downloadRuntime");
  return findAgentBridge(agentId)?.displayName ?? agentId;
}

export function setupDownloadProgress(output: Output) {
  let current: NativeDownloadProgress | undefined;
  let firstByteAt = 0;
  let firstBytes = 0;
  let lastByteAt = 0;

  function onDownload(event: NativeDownloadProgress): void {
    const now = performance.now();
    if (event.receivedBytes === 0 || !current?.receivedBytes) {
      firstByteAt = now;
      firstBytes = event.receivedBytes;
    }
    current = event;
    lastByteAt = now;
  }

  function label(): string {
    if (!current) return setupWords(output, "downloadPreparing");
    const { artifact, attempt, receivedBytes } = current;
    const name = downloadName(output, artifact.agentId);
    if (receivedBytes === artifact.sizeBytes) return setupWords(output, "downloadVerifying", { name });
    if (attempt > 1 && receivedBytes === 0) return setupWords(output, "downloadRetrying", { name, attempt });
    const percent = Math.floor(100 * receivedBytes / artifact.sizeBytes);
    const progress = `${(receivedBytes / MIB).toFixed(1)}/${(artifact.sizeBytes / MIB).toFixed(1)} MiB (${percent}%)`;
    if (!receivedBytes || performance.now() - lastByteAt >= WAITING_MS) {
      return setupWords(output, "downloadWaiting", { name, progress });
    }
    return `${name} · ${downloadEstimate(progress, receivedBytes, artifact.sizeBytes)}`;
  }

  function downloadEstimate(progress: string, received: number, total: number): string {
    const elapsed = lastByteAt - firstByteAt;
    if (elapsed < 1_000) return progress;
    const bytesPerSecond = (received - firstBytes) * 1_000 / elapsed;
    if (bytesPerSecond <= 0) return progress;
    const seconds = Math.ceil((total - received) / bytesPerSecond);
    return setupWords(output, "downloadEta", { progress, speed: (bytesPerSecond / MIB).toFixed(1), eta: estimateTime(output, seconds) });
  }

  return { label, onDownload };
}
