import { RemoteInstanceError, type RelayChannel } from "@konteks/remote-common";

/** Local projection of the caller's durably accepted Core recovery generation.
 * This transport seam never creates authority. An omitted provider fails closed.
 */
export class RecoveryAuthority {
  constructor(private readonly current: () => string | null = () => null) {}

  permits(channel: RelayChannel): boolean {
    return channel === "control" || channel === "heartbeat" || Boolean(this.current());
  }

  capture(channel: RelayChannel): () => void {
    if (channel === "control" || channel === "heartbeat") return () => undefined;
    const identity = this.current();
    const assertCurrent = () => {
      if (!identity || this.current() !== identity) throw new RemoteInstanceError("recovery_required", "Transport recovery generation is not currently accepted.");
    };
    assertCurrent();
    return assertCurrent;
  }
}
