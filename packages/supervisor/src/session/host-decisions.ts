import { isAbsolute, resolve } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

/** A refusal of a host agent's permission request, with the reason the person and the agent read. */
export function refusal(reason: string): { kind: "deny"; reason: string } {
  return { kind: "deny", reason };
}

/** A host agent's request rebuilt from the call it names, for the runtime policy to judge. */
export function rebuiltRequest(
  request: RequestPermissionRequest,
  toolCallId: string,
  toolCall: Omit<RequestPermissionRequest["toolCall"], "toolCallId">,
): { kind: "evaluate"; request: RequestPermissionRequest } {
  return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, ...toolCall } } };
}

/** `path` as an absolute path, a relative one taken from `cwd`. */
export function resolveIn(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}
