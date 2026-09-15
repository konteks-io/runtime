import { readFile } from "node:fs/promises";
import { z } from "zod";
import { isFsErrorWithCode, writeSecretFile } from "@konteks/remote-common";

/**
 * Resumable install state. Each phase is persisted when it completes, so a
 * rerun after network loss, a closed terminal, or a reboot continues from
 * the last durable point instead of creating a duplicate identity or
 * repeating a pull. The activation code is never part of this state; the
 * agent set and auth modes are, so `update` re-renders the same bundle.
 */
export const InstallPhaseSchema = z.enum(["preflight", "exchanged", "verified", "pulled", "configured", "started", "ready", "failed"]);
export type InstallPhase = z.infer<typeof InstallPhaseSchema>;

export const InstalledAgentSchema = z
  .object({
    agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    authMode: z.enum(["agent_local_subscription", "gateway_keyed"]),
  })
  .strict();
export type InstalledAgent = z.infer<typeof InstalledAgentSchema>;

export const InstallStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    activationId: z.string().min(1),
    phase: InstallPhaseSchema,
    instanceId: z.string().min(1).nullable(),
    bundleVersion: z.string().min(1).nullable(),
    manifestDigest: z.string().min(1).nullable(),
    provisioningWindowExpiresAt: z.string().nullable(),
    agents: z.array(InstalledAgentSchema),
    pulledImages: z.array(z.string()),
    updatedAt: z.string(),
    lastError: z.string().max(512).nullable(),
  })
  .strict();
export type InstallState = z.infer<typeof InstallStateSchema>;

const ORDER: InstallPhase[] = ["preflight", "exchanged", "verified", "pulled", "configured", "started", "ready"];

export function phaseIndex(phase: InstallPhase): number {
  return ORDER.indexOf(phase);
}

export function phaseReached(state: InstallState, phase: InstallPhase): boolean {
  return state.phase !== "failed" && phaseIndex(state.phase) >= phaseIndex(phase);
}

export function initialInstallState(activationId: string, now: string, agents: InstalledAgent[]): InstallState {
  return { schemaVersion: 1, activationId, phase: "preflight", instanceId: null, bundleVersion: null, manifestDigest: null, provisioningWindowExpiresAt: null, agents, pulledImages: [], updatedAt: now, lastError: null };
}

/** Phases only move forward; `failed` records the error and keeps every durable fact so a rerun resumes. */
export function advance(state: InstallState, phase: InstallPhase, now: string, patch: Partial<Omit<InstallState, "phase" | "updatedAt" | "schemaVersion">> = {}): InstallState {
  if (phase !== "failed" && phaseIndex(phase) < phaseIndex(state.phase)) return state;
  return { ...state, ...patch, phase, updatedAt: now, lastError: phase === "failed" ? (patch.lastError ?? state.lastError) : null };
}

/** After a `failed` phase, the highest phase whose durable facts exist decides where a rerun resumes. */
export function resumePhase(state: InstallState): InstallPhase {
  if (state.phase !== "failed") return state.phase;
  if (!state.instanceId) return "preflight";
  return "verified";
}

export class InstallStateFile {
  constructor(private readonly path: string) {}

  async read(): Promise<InstallState | null> {
    try {
      return InstallStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (isFsErrorWithCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async write(state: InstallState): Promise<void> {
    await writeSecretFile(this.path, `${JSON.stringify(InstallStateSchema.parse(state), null, 2)}\n`);
  }
}
