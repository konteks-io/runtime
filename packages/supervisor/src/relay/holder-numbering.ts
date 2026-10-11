import { jcsDigest, type JsonValue, type ToRuntimeRelayFrame } from "@konteks/remote-common";

/** How many received to_runtime frames a holder-bound channel remembers by sequence. */
const REMEMBERED_FRAMES = 256;

/**
 * What an inbound holder frame is against the receive cursor. `renumbered`:
 * the holder restarted its numbering at 1 (it lost its own durable state).
 */
export type HolderReceipt =
  | { kind: "next" | "duplicate" | "gap"; digest: string }
  | { kind: "renumbered"; digest: string; evidence: "digest" | "issued_at" };

/** A received frame's identity: the holder's timestamp and body. A replay keeps both. */
function receiptDigest(frame: ToRuntimeRelayFrame): string {
  return jcsDigest({ issuedAt: frame.issuedAt, body: frame.body as JsonValue });
}

/**
 * Evidence about one holder's to_runtime numbering. A frame at or below the
 * cursor is a replay unless it proves a new numbering: a different frame at
 * a remembered sequence, or a holder timestamp later than every frame
 * received so far (`issuedAt` comes from the holder's clock and is compared
 * only with the holder's own timestamps). Frames of a retired numbering are
 * remembered by digest so a late replay of one is still dropped.
 */
export class HolderNumbering {
  private readonly bySeq = new Map<number, string>();
  private readonly retired = new Set<string>();

  /** The latest holder timestamp received; durable with the receive cursor. */
  constructor(public lastIssuedAt: string | undefined) {}

  receipt(frame: ToRuntimeRelayFrame, receivedCursor: number): HolderReceipt {
    const digest = receiptDigest(frame);
    if (this.retired.has(digest)) return { kind: "duplicate", digest };
    if (frame.seq > receivedCursor) return { kind: frame.seq === receivedCursor + 1 ? "next" : "gap", digest };
    const evidence = this.renumberEvidence(frame, digest);
    if (evidence === null) return { kind: "duplicate", digest };
    // A new numbering starts at 1; a later one first means its start was lost in transit.
    return frame.seq === 1 ? { kind: "renumbered", digest, evidence } : { kind: "gap", digest };
  }

  /** The frame was accepted; a renumbering retires what the old numbering left first. */
  accepted(frame: ToRuntimeRelayFrame, receipt: HolderReceipt): void {
    if (receipt.kind === "renumbered") this.retireNumbering();
    this.remember(frame.seq, receipt.digest);
    this.lastIssuedAt = laterIssuedAt(this.lastIssuedAt, frame.issuedAt);
  }

  private renumberEvidence(frame: ToRuntimeRelayFrame, digest: string): "digest" | "issued_at" | null {
    const known = this.bySeq.get(frame.seq);
    if (known !== undefined) return known === digest ? null : "digest";
    return this.lastIssuedAt !== undefined && Date.parse(frame.issuedAt) > Date.parse(this.lastIssuedAt) ? "issued_at" : null;
  }

  private retireNumbering(): void {
    for (const digest of this.bySeq.values()) {
      this.retired.add(digest);
      if (this.retired.size > REMEMBERED_FRAMES) this.retired.delete(this.retired.values().next().value!);
    }
    this.bySeq.clear();
  }

  private remember(seq: number, digest: string): void {
    this.bySeq.set(seq, digest);
    for (const key of this.bySeq.keys()) {
      if (this.bySeq.size <= REMEMBERED_FRAMES) break;
      this.bySeq.delete(key);
    }
  }
}

/** The later of two holder timestamps; an unparseable one never wins. */
export function laterIssuedAt(current: string | undefined, candidate: string): string | undefined {
  if (Number.isNaN(Date.parse(candidate))) return current;
  return current === undefined || Date.parse(candidate) > Date.parse(current) ? candidate : current;
}
