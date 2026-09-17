import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isFsErrorWithCode, RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";

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
   * What this workspace's agents are set to, if anything (W1-A6).
   *
   * A workspace made from a coding agent has never been through the setup the
   * site offers, so its first session has no profile to run with and every
   * turn is refused. Onboarding reads this and, when nothing is configured,
   * chooses what the machine itself advertises.
   */
  async agentSetupReadiness(): Promise<string> {
    const body = (await this.call("GET", "/api/app/agent-setup/status")) as { readiness?: unknown };
    return typeof body.readiness === "string" ? body.readiness : "never_configured";
  }

  /**
   * Set the workspace's agents up from what this machine advertises: the
   * recommended option for every role the setup requires. It is the person's
   * own machine and their own agent login, so there is nothing to ask.
   */
  async setUpAgentsFromThisMachine(): Promise<{ operationId: string } | null> {
    const capabilities = (await this.call("GET", "/api/app/agent-setup/capabilities")) as {
      contractVersion?: unknown;
      setupVersion?: unknown;
      presetRevision?: unknown;
      roles?: Record<string, { required?: boolean; recommendedOptionId?: string; preferredOptionId?: string; options?: Array<{ optionId: string; availability?: string }> }>;
    };
    const roles = capabilities.roles ?? {};
    const selections: Record<string, { optionId: string }> = {};
    for (const [role, offer] of Object.entries(roles)) {
      const optionId =
        offer.recommendedOptionId ??
        offer.preferredOptionId ??
        offer.options?.find(option => option.availability === "available")?.optionId;
      if (optionId) selections[role] = { optionId };
      else if (offer.required) return null;
    }
    if (!selections.planner || !selections.executor || !selections.assistant || !selections.search) return null;
    const body = (await this.call(
      "PUT",
      "/api/app/agent-setup",
      {
        contractVersion: capabilities.contractVersion,
        setupVersion: capabilities.setupVersion,
        presetRevision: capabilities.presetRevision,
        selections,
      },
      { "Idempotency-Key": `onboarding-setup:${String(capabilities.setupVersion)}` },
    )) as { operationId?: unknown };
    return typeof body.operationId === "string" ? { operationId: body.operationId } : null;
  }

  /** How far the setup has got, for the person to be told honestly. */
  async agentSetupOperation(operationId: string): Promise<{ state: string }> {
    const body = (await this.call("GET", `/api/app/agent-setup/${encodeURIComponent(operationId)}`)) as { state?: unknown };
    return { state: typeof body.state === "string" ? body.state : "validating" };
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
