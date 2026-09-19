import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isFsErrorWithCode, RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";

/** What the person hears once their access on this machine was revoked in Settings. */
export const OWNER_ACCESS_REVOKED =
  "Your Konteks access on this machine was revoked in Settings, so nothing more can be done as you from here.";

/**
 * The person's own credential, and the three calls the onboarding flow makes
 * with it (onboarding-simplified OS13, OS15, core chapter §5–§6).
 *
 * It is a login for that person on this machine, so it is treated as one: a
 * secret file, never printed, never logged, refreshed rather than kept long,
 * and used for exactly the calls the `onboard` steps make and nothing else.
 */

const StoredTokenSchema = z
  .object({
    schemaVersion: z.literal(1),
    token: z.string().min(1),
    expiresAt: z.string().min(1),
    userRef: z.string().min(1),
    tenantId: z.string().min(1),
    instanceId: z.string().min(1),
  })
  .strict();

export type StoredOwnerToken = z.infer<typeof StoredTokenSchema>;

const FILE = "owner-token.json";

export function ownerTokenPath(supervisorData: string): string {
  return join(supervisorData, FILE);
}

export async function readOwnerToken(supervisorData: string): Promise<StoredOwnerToken | null> {
  const raw = await readFile(ownerTokenPath(supervisorData), "utf8").catch(error => {
    if (isFsErrorWithCode(error, "ENOENT")) return null;
    throw error;
  });
  if (raw === null) return null;
  const parsed = StoredTokenSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function deleteOwnerToken(supervisorData: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(ownerTokenPath(supervisorData), { force: true });
}

export async function writeOwnerToken(
  supervisorData: string,
  token: Omit<StoredOwnerToken, "schemaVersion">,
): Promise<void> {
  await writeSecretFile(
    ownerTokenPath(supervisorData),
    JSON.stringify(StoredTokenSchema.parse({ ...token, schemaVersion: 1 })),
  );
}

const FirstSystemSchema = z
  .object({
    systemId: z.string().min(1),
    systemEntityRef: z.string().min(1),
    componentEntityRef: z.string().min(1),
    repository: z
      .object({
        kind: z.enum(["existing", "managed"]),
        remoteUrl: z.string().optional(),
        /** Where the runtime pushes with its own key (managed only). */
        sshUrl: z.string().optional(),
        defaultBranch: z.string(),
      })
      .strict(),
  })
  .strict();

export type FirstSystemRegistered = z.infer<typeof FirstSystemSchema>;

/** One agent this machine advertises for a role, as the capabilities read names it. */
interface MachineAgentOption {
  optionId: string;
  runtimeId?: string;
  providerId?: string;
  modelId: string;
  availability?: string;
}

export class OwnerApiClient {
  constructor(
    private readonly options: {
      coreUrl: string;
      token: string;
      fetchFn?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  /** The first System, from the repository this machine is standing in. */
  async registerFirstSystem(input: {
    name: string;
    hostLabel: string;
    repository: { kind: "existing" | "managed"; remoteUrl?: string; defaultBranch: string };
  }): Promise<FirstSystemRegistered> {
    const body = await this.call("POST", "/api/app/catalog/systems/first", input);
    const parsed = FirstSystemSchema.safeParse(body);
    if (!parsed.success) {
      throw new RemoteInstanceError("temporarily_unavailable", "Konteks did not answer with a System.");
    }
    return parsed.data;
  }

  /**
   * Whether this workspace can already run work (W1-A6).
   *
   * A workspace made from a coding agent has never been through the setup the
   * site offers, so it has no execution profile and its first session is
   * refused for want of one. Any profile at all means somebody has chosen.
   */
  async hasExecutionProfile(): Promise<boolean> {
    const body = (await this.call("GET", "/api/app/execution-profiles")) as { profiles?: unknown };
    return Array.isArray(body.profiles) && body.profiles.length > 0;
  }

  /**
   * Make this machine's own agents the workspace's default execution profile:
   * the recommended option for the planner and the executor, which are the
   * person's own agent logins on their own machine, so there is nothing to ask.
   * Answers false when the machine advertises nothing that can carry the work.
   */
  async setUpAgentsFromThisMachine(name: string): Promise<boolean> {
    const capabilities = (await this.call("GET", "/api/app/agent-setup/capabilities")) as {
      roles?: Record<string, { recommendedOptionId?: string; preferredOptionId?: string; options?: MachineAgentOption[] }>;
    };
    const roles = capabilities.roles ?? {};
    const pick = (role: string): MachineAgentOption | undefined => {
      const offer = roles[role];
      if (!offer) return undefined;
      const wanted = offer.recommendedOptionId ?? offer.preferredOptionId;
      const options = offer.options ?? [];
      return options.find(option => option.optionId === wanted) ?? options.find(option => option.availability === "available");
    };
    const planner = pick("planner") ?? pick("assistant");
    const executor = pick("executor") ?? planner;
    if (!planner || !executor) return false;
    const role = (option: MachineAgentOption) => ({
      ...(option.runtimeId ? { runtimeId: option.runtimeId, agentId: option.runtimeId } : {}),
      ...(option.providerId ? { provider: option.providerId } : {}),
      model: option.modelId,
      authMode: "managed_local_auth" as const,
    });
    const created = (await this.call("POST", "/api/app/execution-profiles", {
      name,
      description: "Set up from this machine when it was connected.",
    })) as { profile?: { id?: unknown } };
    const profileId = typeof created.profile?.id === "string" ? created.profile.id : "";
    if (!profileId) throw new RemoteInstanceError("temporarily_unavailable", "Konteks did not answer with a profile.");
    await this.call("POST", `/api/app/execution-profiles/${encodeURIComponent(profileId)}/revisions`, {
      configuration: { planner: role(planner), executor: role(executor) },
      makeDefault: true,
    });
    return true;
  }

  /**
   * The person's first initiative on that System (W1-A6).
   *
   * Core's initiative setup creates the initiative and opens its planning
   * session under this same token, exactly as New initiative does on the site.
   */
  async createInitiative(input: { systemId: string; title: string }): Promise<{
    initiativeId: string;
    title: string;
    pmSessionId?: string;
    setupFailure?: string;
  }> {
    const body = (await this.call("POST", "/api/collaboration/initiatives", {
      systemId: input.systemId,
      title: input.title,
    })) as Record<string, unknown>;
    const initiative = (body.initiative ?? {}) as Record<string, unknown>;
    const initiativeId = typeof initiative.id === "string" ? initiative.id : "";
    if (!initiativeId) {
      throw new RemoteInstanceError("temporarily_unavailable", "Konteks did not answer with an initiative.");
    }
    const pmSessionId =
      typeof body.pmSessionId === "string" && body.pmSessionId
        ? body.pmSessionId
        : typeof initiative.pmSessionId === "string" && initiative.pmSessionId
          ? initiative.pmSessionId
          : undefined;
    const failure = body.spawnFailure as { message?: unknown } | undefined;
    return {
      initiativeId,
      title: typeof initiative.title === "string" ? initiative.title : input.title,
      ...(pmSessionId ? { pmSessionId } : {}),
      ...(failure && typeof failure.message === "string" ? { setupFailure: failure.message } : {}),
    };
  }

  /** A project-management session scoped to that System (OS13). */
  async createProjectManagementSession(input: {
    systemId: string;
    instanceId: string;
    title: string;
  }): Promise<{ sessionId: string }> {
    const body = (await this.call("POST", "/api/app/sessions", {
      mode: "project_management",
      title: input.title,
      system_id: input.systemId,
      runtimeTarget: { kind: "specific_instance", instanceId: input.instanceId },
    })) as Record<string, unknown>;
    const sessionId = String(body.id ?? body.session_id ?? "");
    if (!sessionId) {
      throw new RemoteInstanceError("temporarily_unavailable", "Konteks did not answer with a session.");
    }
    return { sessionId };
  }

  /** The person's first sentence becomes the session's first turn. */
  async postFirstTurn(sessionId: string, content: string): Promise<void> {
    // The session message API takes `message`; `content`/`role` is refused as
    // a malformed body, which left the planning session with nothing to answer.
    await this.call("POST", `/api/app/sessions/${encodeURIComponent(sessionId)}/messages`, {
      message: content,
    });
  }

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const doFetch = this.options.fetchFn ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.options.coreUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          Authorization: `Bearer ${this.options.token}`,
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
    } catch {
      throw new RemoteInstanceError("temporarily_unavailable", "Konteks could not be reached.");
    }
    if (response.status === 401 || response.status === 403) {
      // Core refuses a token revoked in Settings at its next use with the code
      // a revoked refresh gets, so the person hears why rather than "refused".
      const detail = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.status === 401 && detail.code === "enrollment_invalid") {
        throw new RemoteInstanceError("permission_denied", OWNER_ACCESS_REVOKED);
      }
      throw new RemoteInstanceError("permission_denied", "This machine's Konteks access was refused.");
    }
    if (response.status === 402) {
      throw new RemoteInstanceError("limit_exceeded", "This workspace has no Story Points left for a first turn.");
    }
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new RemoteInstanceError(
        "temporarily_unavailable",
        typeof detail.message === "string" ? detail.message : `Konteks answered ${response.status}.`,
      );
    }
    return response.json().catch(() => ({}));
  }
}
