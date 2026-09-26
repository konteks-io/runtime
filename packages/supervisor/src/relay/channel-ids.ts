import type { RelayChannel } from "@konteks/remote-common";

/**
 * Channel identifiers. Core-bound streams (`control`, `heartbeat`,
 * `assignment`, `observation`, `support`) are minted `<channel>:<instanceId>`
 * so the relay can tell from a handshake whose endpoint cursor to ask (CP9
 * `channelKindOf`); `session` ids are minted per stream by their owners
 * and also lead with the channel name. The channel name before
 * the first `:` is therefore always the authoritative `RelayChannel`.
 */
export const CORE_BOUND_CHANNELS = Object.freeze(["control", "heartbeat", "assignment", "observation"] as const);
export type CoreBoundChannel = (typeof CORE_BOUND_CHANNELS)[number] | "support";

export function coreChannelId(channel: CoreBoundChannel, instanceId: string): string {
  return `${channel}:${instanceId}`;
}

export function channelOfId(channelId: string): RelayChannel | null {
  const head = channelId.split(":")[0];
  switch (head) {
    case "control":
    case "heartbeat":
    case "assignment":
    case "session":
    case "observation":
    case "support":
      return head;
    default:
      return null;
  }
}
