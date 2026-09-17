import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RemoteInstanceError, createLogger, runCommand, sanitizeInheritedChildProcessEnv, type Logger } from "@konteks/remote-common";
import type { ManagedGitBinding } from "./remotes.js";

/**
 * Managed-git key registration on this machine (ON16, OB6 §4).
 *
 * The runtime is already the trusted machine, so the key it uses for managed
 * git is generated HERE and registered by its public half alone. **The private
 * half never leaves this machine**: it is never read back over the control
 * socket, never journaled, never included in a support bundle, and the App
 * shows the launcher command rather than a field to paste a key into.
 *
 * Removing the key revokes it in Core; so does removing the runtime, because
 * Core registers every key against this instance id (OB4 §1).
 */

/** What the runtime keeps locally about a key it registered. */
export const RegisteredGitKeySchema = z
  .object({
    keyRef: z.string().min(1).max(200),
    title: z.string().min(1).max(256),
    fingerprint: z.string().min(1).max(256),
    /**
     * The managed git host this key opens, where the registration named one.
     * Managed git registers a key for the person, not for one host, so the
     * answer may carry none; the repository's own SSH URL is then what a push
     * uses (WS1-026), and the host-matching resolver simply has no binding.
     */
    host: z.string().min(1).max(255).optional(),
    user: z.string().min(1).max(64).optional(),
    createdAt: z.string().min(1).max(64),
  })
  .strict();
export type RegisteredGitKey = z.infer<typeof RegisteredGitKeySchema>;

const KeyFileSchema = z.object({ keys: z.array(RegisteredGitKeySchema).max(16) }).strict();

/**
 * Core's side of the registration. `user` and `revokedAt` admit `undefined`
 * explicitly because the implementation is a parsed response, and under
 * `exactOptionalPropertyTypes` an absent optional and one set to `undefined`
 * are different types.
 */
export interface GitKeyRegistrar {
  register(input: { publicKey: string; title: string }): Promise<{ keyRef: string; fingerprint: string; host?: string | undefined; user?: string | undefined; createdAt?: string | undefined }>;
  list(): Promise<Array<{ keyRef: string; title: string; fingerprint: string; createdAt: string; revokedAt?: string | undefined }>>;
  revoke(keyRef: string): Promise<void>;
}

export interface GitKeyStoreOptions {
  /** Private directory the key material lives in; 0700, never backed up. */
  directory: string;
  registrar: GitKeyRegistrar;
  run?: typeof runCommand;
  logger?: Logger;
}

const PRIVATE_KEY_FILE = "konteks_managed_git";
const RECORD_FILE = "keys.json";
const SSH_CONFIG_FILE = "ssh_config";

export class GitKeyStore {
  private readonly run: typeof runCommand;
  private readonly logger: Logger;

  constructor(private readonly options: GitKeyStoreOptions) {
    this.run = options.run ?? runCommand;
    this.logger = options.logger ?? createLogger({ name: "onboard-git-keys" });
  }

  get privateKeyPath(): string {
    return join(this.options.directory, PRIVATE_KEY_FILE);
  }

  /**
   * `git key add`. The key is generated once and REUSED: a person who runs the
   * command twice gets the same key registered under a second title rather than
   * a second key and a broken clone on the machine's other terminals.
   */
  async add(title: string): Promise<RegisteredGitKey> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const publicKey = await this.ensureKeyPair(title);
    const registered = await this.options.registrar.register({ publicKey, title });
    const key: RegisteredGitKey = RegisteredGitKeySchema.parse({
      keyRef: registered.keyRef,
      title,
      fingerprint: registered.fingerprint,
      ...(registered.host ? { host: registered.host } : {}),
      createdAt: registered.createdAt ?? new Date().toISOString(),
      ...(registered.user ? { user: registered.user } : {}),
    });
    const current = await this.records();
    await this.save([...current.filter(entry => entry.keyRef !== key.keyRef), key]);
    if (key.host !== undefined) await this.writeSshConfig({ ...key, host: key.host });
    this.logger.info({ keyRef: key.keyRef, host: key.host }, "registered a managed git key for this runtime");
    return key;
  }

  /** `git key list`. Core is the authority; the local record is a convenience. */
  async list(): Promise<Array<{ keyRef: string; title: string; fingerprint: string; createdAt: string; revokedAt?: string | undefined }>> {
    return this.options.registrar.list();
  }

  /** `git key remove`. Revoked in Core first; only then is the local half dropped. */
  async remove(keyRef: string): Promise<void> {
    await this.options.registrar.revoke(keyRef);
    const remaining = (await this.records()).filter(entry => entry.keyRef !== keyRef);
    await this.save(remaining);
    if (remaining.length === 0) {
      await rm(this.privateKeyPath, { force: true });
      await rm(`${this.privateKeyPath}.pub`, { force: true });
      await rm(join(this.options.directory, SSH_CONFIG_FILE), { force: true });
    }
  }

  /** The binding the collector and the relocation worker resolve remotes with. */
  async binding(): Promise<ManagedGitBinding | null> {
    const [key] = await this.records();
    if (!key?.host) return null;
    return { host: key.host, identityFile: this.privateKeyPath, ...(key.user ? { user: key.user } : {}) };
  }

  private async ensureKeyPair(title: string): Promise<string> {
    const existing = await readFile(`${this.privateKeyPath}.pub`, "utf8").catch(() => null);
    if (existing && existing.trim().length > 0) return existing.trim();
    const result = await this.run({
      command: "ssh-keygen",
      args: ["-t", "ed25519", "-f", this.privateKeyPath, "-N", "", "-C", title.slice(0, 200), "-q"],
      env: sanitizeInheritedChildProcessEnv({ env: process.env }),
      timeoutMs: 60_000,
    });
    if (result.code !== 0) {
      throw new RemoteInstanceError("prerequisite_missing", "This machine has no `ssh-keygen`; install OpenSSH and run the command again.", {
        recoveryActions: [{ kind: "run_doctor" }],
        diagnostic: "ssh_keygen_missing",
      });
    }
    await chmod(this.privateKeyPath, 0o600).catch(() => undefined);
    const created = await readFile(`${this.privateKeyPath}.pub`, "utf8");
    return created.trim();
  }

  /**
   * The stanza is written to a file this runtime owns, NOT into the person's
   * `~/.ssh/config`: nothing in this toolkit edits host configuration behind a
   * person's back. `git key add` prints the one `Include` line they can add if
   * they also want to clone by hand — the runtime itself needs no include,
   * because it passes the identity file to ssh directly.
   */
  private async writeSshConfig(key: RegisteredGitKey & { host: string }): Promise<void> {
    const stanza = [
      `# Written by konteks-remote git key add. Include it from ~/.ssh/config to`,
      `# clone managed Konteks repositories by hand with the same key.`,
      `Host ${key.host}`,
      `  User ${key.user ?? "git"}`,
      `  IdentityFile ${this.privateKeyPath}`,
      `  IdentitiesOnly yes`,
      "",
    ].join("\n");
    await writeFile(join(this.options.directory, SSH_CONFIG_FILE), stanza, { mode: 0o600 });
  }

  private async records(): Promise<RegisteredGitKey[]> {
    const raw = await readFile(join(this.options.directory, RECORD_FILE), "utf8").catch(() => null);
    if (!raw) return [];
    const parsed = KeyFileSchema.safeParse(safeJson(raw));
    return parsed.success ? parsed.data.keys : [];
  }

  private async save(keys: readonly RegisteredGitKey[]): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.options.directory, RECORD_FILE), `${JSON.stringify({ keys }, null, 2)}\n`, { mode: 0o600 });
  }
}

/** The path a person is told to include; never the private key itself. */
export function sshConfigPath(directory: string): string {
  return join(directory, SSH_CONFIG_FILE);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
