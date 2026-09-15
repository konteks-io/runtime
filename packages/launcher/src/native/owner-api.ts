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
    await this.call("POST", `/api/app/sessions/${encodeURIComponent(sessionId)}/messages`, {
      content,
      role: "user",
    });
  }

  private async call(method: string, path: string, body: unknown): Promise<unknown> {
    const doFetch = this.options.fetchFn ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.options.coreUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify(body),
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
