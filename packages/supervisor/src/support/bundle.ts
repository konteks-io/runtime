import { randomUUID } from "node:crypto";
import { containsCanary, redactText, redactValue, sha256Hex, type DoctorReport, type SupportChunk } from "@konteks/remote-common";

/**
 * Support bundle: an allowlisted, redacted, bounded set of facts — versions,
 * status, configuration KEYS without values, doctor output, counters — that
 * the operator previews locally before it is sent as `support` chunks. It
 * never contains agent volumes, checkpoint references,
 * task-checkout paths, prompts, model output, or a credential.
 */
export interface SupportBundleInputs {
  bundleVersion: string;
  protocolVersion: string;
  instanceId: string | null;
  administrativeStatus: string;
  doctor: DoctorReport;
  configurationKeys: string[];
  counters: Record<string, number | Record<string, number>>;
  recentLogLines: string[];
  generatedAt: string;
}

export interface SupportBundle {
  bundleId: string;
  document: Record<string, unknown>;
  chunks: SupportChunk[];
}

const MAX_LOG_LINES = 500;
const CHUNK_BYTES = 48 * 1024;

export function buildSupportBundle(inputs: SupportBundleInputs): SupportBundle {
  const document = redactValue({
    schema: "konteks-remote-support-bundle/1",
    generatedAt: inputs.generatedAt,
    versions: { bundle: inputs.bundleVersion, protocol: inputs.protocolVersion },
    instance: { instanceId: inputs.instanceId, administrativeStatus: inputs.administrativeStatus },
    configurationKeys: [...inputs.configurationKeys].sort(),
    doctor: inputs.doctor,
    counters: inputs.counters,
    logs: inputs.recentLogLines.slice(-MAX_LOG_LINES).map((line) => redactText(line).slice(0, 2_048)),
  }) as Record<string, unknown>;
  const text = JSON.stringify(document);
  if (containsCanary(text)) throw new Error("support bundle failed the secret scan");
  const bundleId = randomUUID();
  const chunks: SupportChunk[] = [];
  const bytes = Buffer.from(text, "utf8");
  const total = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  for (let index = 0; index < total; index += 1) {
    const slice = bytes.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, bytes.byteLength));
    chunks.push({ bundleId, index, total, contentType: "application/json", body: slice.toString("base64url"), sha256: sha256Hex(slice) });
  }
  return { bundleId, document, chunks };
}
