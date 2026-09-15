import { isAbsolute } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  isFsErrorWithCode,
  JsonClient,
  RemoteInstanceError,
  signInstanceProof,
  type Clock,
  type FetchFn,
  type JsonValue,
} from "@konteks/remote-common";
import { z } from "zod";
import { SupervisorStore } from "../state/store.js";
import { StateMutationGate } from "../state/mutation-gate.js";
import { acquireNativeRootLock } from "./root-lock.js";

/**
 * The runtime's half of agent-first enrollment (onboarding-simplified OS5–OS9).
 *
 * This is the launcher's client, not the supervisor's: at enrollment time no
 * supervisor is running, there is no identity and no lease, and the process
 * that must speak is the one the person's coding agent invoked. It follows the
 * activation exchange exactly — same store, same root lock, same key — because
 * the key it creates here is the key the machine keeps.
 *
 * Nothing here ever holds the person's address longer than the call that needs
 * it, and the emitted proofs are the only authority: Core matches them against
 * the key recorded on the intent.
 */

const CORE_AUDIENCE = "konteks:remote-instance";
const BASE = "/api/remote-instances/internal/remote-instances/enrollment";

export const ENROLLMENT_PATHS = Object.freeze({
  intents: `${BASE}/intents`,
  intent: (ref: string) => `${BASE}/intents/${encodeURIComponent(ref)}`,
  challenge: (ref: string) => `${BASE}/intents/${encodeURIComponent(ref)}/challenge`,
  verify: (ref: string) => `${BASE}/intents/${encodeURIComponent(ref)}/verify`,
  bind: (ref: string) => `${BASE}/intents/${encodeURIComponent(ref)}/bind`,
  token: `${BASE}/token`,
});

const IntentOpenedSchema = z
  .object({ intentRef: z.string().min(1), status: z.string().min(1), expiresAt: z.string().min(1) })
  .strict();

const ChallengeSentSchema = z
  .object({
    sentToMasked: z.string().min(1),
    expiresAt: z.string().min(1),
    attemptsRemaining: z.number().int().min(0),
  })
  .strict();

const WorkspaceChoiceSchema = z
  .object({ tenantId: z.string().min(1), displayName: z.string().min(1) })
  .strict();

const VerifiedSchema = z
  .object({
    decision: z.enum(["join", "choose", "create"]),
    workspaces: z.array(WorkspaceChoiceSchema).optional(),
    proposedTenantId: z.string().optional(),
  })
  .strict();

const OwnerTokenSchema = z
  .object({
    token: z.string().min(1),
    expiresAt: z.string().min(1),
    userRef: z.string().min(1),
    tenantId: z.string().min(1),
  })
  .strict();

const BoundSchema = z
  .object({
    identity: z.object({ instanceId: z.string().min(1), workspaceId: z.string().min(1) }).strict(),
    provisioningCredential: z.string().min(1),
    provisioningCredentialExpiresAt: z.string().min(1),
    provisioningWindowExpiresAt: z.string().min(1),
    bundleManifest: z.unknown(),
    ownerToken: OwnerTokenSchema,
    workspaceCreated: z.boolean(),
  })
  .strict();

export type EnrollmentIntentOpened = z.infer<typeof IntentOpenedSchema>;
export type EnrollmentChallengeSent = z.infer<typeof ChallengeSentSchema>;
export type EnrollmentVerified = z.infer<typeof VerifiedSchema>;
export type EnrollmentBound = z.infer<typeof BoundSchema>;
export type OwnerTokenGrant = z.infer<typeof OwnerTokenSchema>;

export interface NativeEnrollmentOptions {
  dataDir: string;
  coreUrl: string;
  clock: Clock;
  fetchFn?: FetchFn;
}

/**
 * One enrollment conversation, held open across separate `onboard` processes.
 *
 * Each method acquires the root lock for the duration of its call and releases
 * it, because the person is typing between steps and a lock held across a
 * question is a lock held for minutes.
 */
export class NativeEnrollment {
  constructor(private readonly options: NativeEnrollmentOptions) {
    if (!isAbsolute(options.dataDir)) {
      throw new RemoteInstanceError("install_state_corrupt", "Enrollment requires an absolute private root.");
    }
  }

  async openIntent(input: {
    platform: { os: string; architecture: string; containerBackend: string; deploymentKind: string };
    requestedRoles: readonly string[];
    bundleVersion: string;
    manifestDigest: string;
  }): Promise<EnrollmentIntentOpened> {
    return this.withKey(async key => {
      const body = {
        publicKeyJwk: key.publicKeyJwk as unknown as JsonValue,
        platform: input.platform as unknown as JsonValue,
        requestedRoles: [...input.requestedRoles] as unknown as JsonValue,
        bundleVersion: input.bundleVersion,
        manifestDigest: input.manifestDigest,
      };
      return this.post(ENROLLMENT_PATHS.intents, body, key, "enrollment_intent", input.manifestDigest, IntentOpenedSchema);
    });
  }

  async sendChallenge(intentRef: string, email: string): Promise<EnrollmentChallengeSent> {
    return this.withKey(key =>
      this.post(ENROLLMENT_PATHS.challenge(intentRef), { email }, key, "enrollment_challenge", intentRef, ChallengeSentSchema),
    );
  }

  async verifyCode(intentRef: string, code: string): Promise<EnrollmentVerified> {
    return this.withKey(key =>
      this.post(ENROLLMENT_PATHS.verify(intentRef), { code }, key, "enrollment_verify", intentRef, VerifiedSchema),
    );
  }

  async bind(intentRef: string, input: { email: string; tenantId?: string }): Promise<EnrollmentBound> {
    return this.withKey(key =>
      this.post(
        ENROLLMENT_PATHS.bind(intentRef),
        { email: input.email, ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
        key,
        "enrollment_bind",
        intentRef,
        BoundSchema,
      ),
    );
  }

  async refreshOwnerToken(instanceId: string): Promise<OwnerTokenGrant> {
    return this.withKey(key =>
      this.post(ENROLLMENT_PATHS.token, { instanceId }, key, "enrollment_token", instanceId, OwnerTokenSchema),
    );
  }

  private async post<T>(
    path: string,
    body: { [key: string]: JsonValue },
    key: { privateKey: unknown; publicKeyJwk: unknown },
    method: string,
    subject: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const client = new JsonClient({
      baseUrl: this.options.coreUrl,
      ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
    });
    return client.request({
      method: "POST",
      path,
      bodyFactory: () => ({
        ...body,
        proof: signInstanceProof(key as never, { method, audience: CORE_AUDIENCE, subject, body }),
      }),
      schema: schema as never,
    }) as Promise<T>;
  }

  /**
   * Run one call holding this machine's key.
   *
   * The key is created on the first call and never again: it is the machine's
   * identity from here on, and the intent Core holds is bound to it.
   */
  private async withKey<T>(run: (key: { privateKey: unknown; publicKeyJwk: unknown }) => Promise<T>): Promise<T> {
    try {
      await mkdir(this.options.dataDir, { mode: 0o700, recursive: true });
    } catch (error) {
      if (!isFsErrorWithCode(error, "EEXIST")) throw error;
    }
    const owner = acquireNativeRootLock(this.options.dataDir);
    const mutations = new StateMutationGate(() => owner.assertOwned());
    try {
      const store = new SupervisorStore(this.options.dataDir, mutations.run);
      await store.init();
      const key = await store.loadOrCreateInstanceKey();
      return await run(key as never);
    } finally {
      owner.release();
    }
  }
}
