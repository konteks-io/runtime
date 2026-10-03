import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isFsErrorWithCode, RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";

/** What the person hears once their access on this machine was revoked in Customize → Runtimes. */
export const OWNER_ACCESS_REVOKED = "This machine's Konteks access was revoked in Customize → Runtimes.";

/**
 * The person's own credential, and the three calls the onboarding flow makes
 * with it.
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

type StoredOwnerToken = z.infer<typeof StoredTokenSchema>;

const FILE = "owner-token.json";

function ownerTokenPath(supervisorData: string): string {
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
    /** The workspace already had this System; this machine now works on it. */
    existing: z.boolean().optional(),
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

type FirstSystemRegistered = z.infer<typeof FirstSystemSchema>;

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
   * Whether this workspace can already run work.
   *
   * A workspace made from a coding agent has never been through the setup the
   * site offers, so its first session needs a ready default revision. A
   * draft or an unrelated profile cannot carry that session.
   */
  async hasExecutionProfile(): Promise<boolean> {
    const body = (await this.call("GET", "/api/app/execution-profiles")) as { profiles?: unknown };
    return Array.isArray(body.profiles) && body.profiles.some((profile: unknown) => {
      if (!profile || typeof profile !== "object") return false;
      const entry = profile as Record<string, unknown>;
      return entry.isDefault === true && entry.status === "active"
        && typeof entry.currentReadyRevision === "number" && entry.currentReadyRevision > 0;
    });
  }

  /**
   * Ask Core's Auto provisioner to bind a ready default using the machine's
   * eligible agents. Core owns role ranking, readiness and retry idempotence.
   */
  async setUpAgentsFromThisMachine(): Promise<boolean> {
    let binding: Record<string, unknown>;
    try {
      binding = (await this.call("POST", "/api/app/execution-profiles/auto")) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof RemoteInstanceError && error.code === "role_not_advertised") return false;
      throw error;
    }
    return typeof binding.executionProfileId === "string" && binding.executionProfileId.length > 0
      && typeof binding.revision === "number" && binding.revision > 0;
  }

  /**
   * Whether this person may start planning work here: a Member or the owner
   * can, a Viewer cannot. Undefined when Konteks cannot say, so a
   * check that fails never stops someone who can.
   */
  async canStartWork(): Promise<boolean | undefined> {
    const body = (await this.call("POST", "/api/platform/permissions/check", { permission: "app.session.manage" }).catch(() => undefined)) as
      | { hasPermission?: unknown }
      | undefined;
    return typeof body?.hasPermission === "boolean" ? body.hasPermission : undefined;
  }

  /**
   * The person's first initiative on that System.
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
    const initiativeId = nonEmptyString(initiative.id);
    if (!initiativeId) {
      throw new RemoteInstanceError("temporarily_unavailable", "Konteks did not answer with an initiative.");
    }
    const pmSessionId = nonEmptyString(body.pmSessionId) ?? nonEmptyString(initiative.pmSessionId);
    const failure = body.spawnFailure as { message?: unknown } | undefined;
    return {
      initiativeId,
      title: typeof initiative.title === "string" ? initiative.title : input.title,
      ...(pmSessionId ? { pmSessionId } : {}),
      ...(typeof failure?.message === "string" ? { setupFailure: failure.message } : {}),
    };
  }

  /** The workspace's name as people see it on the site, or undefined when Core does not say. */
  async workspaceDisplayName(tenantId: string): Promise<string | undefined> {
    const body = await this.call("GET", "/api/platform/tenants");
    const match = (Array.isArray(body) ? body : []).find(
      (entry: unknown): entry is { displayName?: unknown } =>
        typeof entry === "object" && entry !== null && (entry as { name?: unknown }).name === tenantId,
    );
    return typeof match?.displayName === "string" && match.displayName.trim() ? match.displayName.trim() : undefined;
  }

  /** The initiatives a System already has, newest first as Konteks lists them. */
  async listInitiatives(systemId: string): Promise<Array<{ id: string; title: string }>> {
    const body = (await this.call("GET", `/api/collaboration/initiatives?systemId=${encodeURIComponent(systemId)}`)) as Record<string, unknown>;
    const list = Array.isArray(body.initiatives) ? (body.initiatives as Array<Record<string, unknown>>) : [];
    return list
      .filter(entry => typeof entry.id === "string" && entry.id)
      .map(entry => ({ id: entry.id as string, title: typeof entry.title === "string" ? entry.title : "" }));
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
    const response = await this.send(method, path, body, headers);
    if (response.status === 401 || response.status === 403) throw refusal(response.status, await jsonDetail(response));
    if (response.status === 402) {
      throw new RemoteInstanceError("limit_exceeded", "This workspace has no Story Points left for a first turn.");
    }
    if (!response.ok) throw failure(response.status, path, await jsonDetail(response));
    return response.json().catch(() => ({}));
  }

  private async send(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    const doFetch = this.options.fetchFn ?? fetch;
    try {
      return await doFetch(`${this.options.coreUrl.replace(/\/+$/, "")}${path}`, {
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
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

async function jsonDetail(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Core refuses a token revoked in Customize → Runtimes at its next use with
 * the code a revoked refresh gets, so the person hears why rather than
 * "refused". Otherwise say what Konteks said: "access was refused" alone sent
 * the person looking at this machine for a refusal that was about something
 * else, such as a proof the Assistant would not accept.
 */
function refusal(status: number, detail: Record<string, unknown>): RemoteInstanceError {
  if (status === 401 && detail.code === "enrollment_invalid") return new RemoteInstanceError("permission_denied", OWNER_ACCESS_REVOKED);
  const said = typeof detail.message === "string" && detail.message.trim() ? detail.message.trim().replace(/([^.!?])$/, "$1.") : "";
  return new RemoteInstanceError("permission_denied", said ? `Konteks refused that request: ${said}` : "This machine's Konteks access was refused.");
}

function failure(status: number, path: string, detail: Record<string, unknown>): RemoteInstanceError {
  if (status === 503 && path === "/api/app/execution-profiles/auto"
    && (detail.error as { code?: unknown } | undefined)?.code === "native_execution_profile_unavailable") {
    return new RemoteInstanceError("role_not_advertised", "Konteks is still learning what this machine's agents can do.");
  }
  return new RemoteInstanceError("temporarily_unavailable", typeof detail.message === "string" ? detail.message : `Konteks answered ${status}.`);
}
