import type { KeyObject } from "node:crypto";
import { PlanningControllerTerminalDirectiveSchema, RemoteControlSigningKeySchema, planningControllerTerminalDirectiveSigningBytes, remoteControlSigningBytes, ed25519PublicKeyFromJwk, ed25519Verify, type JsonValue, type PlanningControllerTerminalDirective } from "@konteks/remote-common";
import type { EmbeddedReleaseRoot } from "@konteks/remote-release";
import { RuntimeCancellationDeliveryRequestSchema, RuntimePermissionAnswerDeliveryRequestSchema } from "@konteks/remote-common";

/**
 * Verification of Core-signed `to_runtime` control bodies (desired
 * configuration, version policy, erase, drain, cancel). Core signs with an
 * Ed25519 control key whose public half the release root certifies
 * (`EmbeddedReleaseRoot.coreControlKeys`), so a forged directive fails even
 * if TLS to Core were compromised.
 */
export class CoreSignatureVerifier {
  private readonly keys = new Map<string, KeyObject>();

  constructor(roots: readonly EmbeddedReleaseRoot[]) {
    const identities = new Map<string, string>();
    for (const root of roots) {
      for (const value of root.coreControlKeys ?? []) {
        const control = RemoteControlSigningKeySchema.parse(value);
        const previous = identities.get(control.keyId);
        if (previous && previous !== control.publicKeyJwk.x) throw new Error("Conflicting Core control key identity");
        identities.set(control.keyId, control.publicKeyJwk.x);
        if (identities.size > 16) throw new Error("Too many Core control keys");
        this.keys.set(control.keyId, ed25519PublicKeyFromJwk(control.publicKeyJwk));
      }
    }
  }

  get configured(): boolean {
    return this.keys.size > 0;
  }

  /** Independent outer proof; the receiver must verify the inner operation. */
  verifyPermissionAnswerDelivery(candidate: unknown): boolean {
    const parsed = RuntimePermissionAnswerDeliveryRequestSchema.safeParse(candidate);
    if (!parsed.success) return false;
    const request = parsed.data, key = this.keys.get(request.keyId);
    if (!key || !/^[A-Za-z0-9_-]{86}$/.test(request.signature) ||
      Buffer.from(request.signature, "base64url").toString("base64url") !== request.signature) return false;
    try { return ed25519Verify(key, remoteControlSigningBytes(request), request.signature); }
    catch { return false; }
  }

  /** Unlike legacy directives, the outer delivery names its exact signing key.
   * The inner directive may use another explicitly retained rotation key. */
  verifyCancellationDelivery(candidate: unknown): boolean {
    const parsed = RuntimeCancellationDeliveryRequestSchema.safeParse(candidate);
    if (!parsed.success) return false;
    const request = parsed.data;
    const key = this.keys.get(request.keyId);
    if (!key || !/^[A-Za-z0-9_-]{86}$/.test(request.signature) ||
      Buffer.from(request.signature, "base64url").toString("base64url") !== request.signature) return false;
    try {
      return ed25519Verify(key, remoteControlSigningBytes(request), request.signature)
        && this.verify(request.intent.directive, request.intent.directive.signature);
    } catch { return false; }
  }

  verify(body: { [key: string]: JsonValue }, signature: string): boolean {
    if (this.keys.size === 0) return false;
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature) || Buffer.from(signature, "base64url").toString("base64url") !== signature) return false;
    try {
      const bytes = remoteControlSigningBytes(body);
      for (const key of this.keys.values()) {
        if (ed25519Verify(key, bytes, signature)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  verifyPlanningTerminal(candidate: PlanningControllerTerminalDirective, tenantId: string, instanceId: string): boolean {
    if (this.keys.size === 0 || !/^[A-Za-z0-9_-]{86}$/.test(candidate.signature) || Buffer.from(candidate.signature, "base64url").toString("base64url") !== candidate.signature) return false;
    try {
      const directive = PlanningControllerTerminalDirectiveSchema.parse(candidate);
      const bytes = planningControllerTerminalDirectiveSigningBytes(tenantId, instanceId, directive);
      for (const key of this.keys.values()) if (ed25519Verify(key, bytes, directive.signature)) return true;
    } catch { return false; }
    return false;
  }

}
