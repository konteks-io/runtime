import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { plainRecord, redactText } from "@konteks/remote-common";
import { boundTitle } from "./activity.js";

/** Core stores at most 512 code points (marker included); bound here so nothing longer leaves the machine. */
export const PERMISSION_REQUEST_DETAIL_MAX = 512;

/**
 * The identifying detail of the exact request a person is asked to allow: the
 * command that would run, the paths a file call would touch, or the URL a
 * fetch would open. It reads the same structured fields the policy judges
 * (`policyInput`), so the card cannot describe a different action.
 */
export function permissionRequestDetail(request: RequestPermissionRequest): string | undefined {
  const input = plainRecord(request.toolCall.rawInput) ?? {};
  const value = identifyingValue(request.toolCall.kind, input, request.toolCall.locations);
  return value === undefined ? undefined : boundDetail(oneLine(value));
}

function identifyingValue(kind: string | null | undefined, input: Record<string, unknown>, locations: RequestPermissionRequest["toolCall"]["locations"]): string | undefined {
  switch (kind) {
    case "execute": return nonBlank(input.command);
    case "edit":
    case "read": return pathsOf(input, locations);
    case "fetch": return nonBlank(input.url);
    default: return undefined;
  }
}

/** The file paths a file call names, from `file_path` and `locations`, in one line. */
function pathsOf(input: Record<string, unknown>, locations: RequestPermissionRequest["toolCall"]["locations"]): string | undefined {
  const named = nonBlank(input.file_path);
  const located = (Array.isArray(locations) ? locations : [])
    .map(location => plainRecord(location)?.path)
    .filter((path): path is string => nonBlank(path) !== undefined);
  const paths = [...new Set([...(named === undefined ? [] : [named]), ...located])];
  return paths.length === 0 ? undefined : paths.join(", ");
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Redact, flatten, drop what the card drops, then cut: the order the escalation title uses. */
function boundDetail(line: string): string | undefined {
  return line.length === 0 ? undefined : boundTitle(line, PERMISSION_REQUEST_DETAIL_MAX);
}

/** Redact first, then flatten and space out what the card sanitizer drops; the cut runs last. */
export function oneLine(value: string): string {
  const flattened = redactText(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ");
  return [...flattened].map(point => droppedByCard(point) ? " " : point).join("").replace(/\s+/g, " ").trim();
}

/** The code-point ranges `sanitizePermissionRequest`'s `plainText` drops. */
const CARD_DROPPED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x7f], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069],
];

function droppedByCard(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  return CARD_DROPPED_RANGES.some(([from, to]) => code >= from && code <= to);
}
