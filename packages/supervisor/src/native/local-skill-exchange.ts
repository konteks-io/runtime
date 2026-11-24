import { discoverLocalSkills } from "../skills/local-skills.js";
import type { CoreClient } from "../core/client.js";
import type { CoreSignatureVerifier } from "../control/core-signature.js";
import { prepareLocalSkillExport } from "./local-skill-export.js";

type ExchangeOptions = {
  core: Pick<CoreClient, "reportLocalSkillInventory" | "pollLocalSkillExport" | "reportLocalSkillExport">;
  verifier: Pick<CoreSignatureVerifier, "verifyLocalSkillExport">;
  homes: () => readonly string[];
  now: () => number;
  identity: () => { workspaceId: string; instanceId: string } | null;
};

/** Best effort, single flight and separate from heartbeat renewal. */
export class LocalSkillExchange {
  private controller: AbortController | undefined;
  private lastInventory: { instanceId: string; workspaceId: string; at: number } | undefined;

  constructor(private readonly options: ExchangeOptions) {}

  kick(): void {
    if (this.controller) return;
    const identity = this.options.identity();
    if (!identity) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.exchange(identity, controller.signal).catch(() => undefined)
      .finally(() => { this.controller = undefined; });
  }

  stop(): void {
    this.controller?.abort();
  }

  private async exchange(identity: NonNullable<ReturnType<ExchangeOptions["identity"]>>, signal: AbortSignal) {
    const { core, now, verifier } = this.options;
    const homes = this.options.homes();
    const current = () => {
      const candidate = this.options.identity();
      if (signal.aborted || candidate?.instanceId !== identity.instanceId || candidate.workspaceId !== identity.workspaceId) return null;
      return candidate;
    };
    const last = this.lastInventory;
    const at = now();
    if (last?.instanceId !== identity.instanceId || last.workspaceId !== identity.workspaceId || at - last.at >= 60_000) {
      const skills = await discoverLocalSkills(homes);
      if (!current()) return;
      await core.reportLocalSkillInventory(identity.instanceId, { observedAt: new Date(now()).toISOString(), skills }, signal);
      this.lastInventory = { ...identity, at };
    }
    const { command } = await core.pollLocalSkillExport(identity.instanceId, signal);
    if (!command) return;
    const result = await prepareLocalSkillExport(command, { verifier, now, homes, identity: current }, signal);
    if (!current()) return;
    await core.reportLocalSkillExport(identity.instanceId, result, signal);
  }
}
