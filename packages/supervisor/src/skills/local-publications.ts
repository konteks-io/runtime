import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";
import {
  LocalSkillPublicationSchema,
  OpaqueIdSchema,
  type LocalSkillPublication,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

const PublicationRecordSchema = z.object({
  binding: z.object({ workspaceId: OpaqueIdSchema, instanceId: OpaqueIdSchema }).strict(),
  localId: z.string().regex(/^[a-f0-9]{64}$/),
  skill: z.string().min(1).max(2048),
  identity: z.string().min(1).max(4096),
  treeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  publication: LocalSkillPublicationSchema,
  revoking: z.boolean().default(false),
}).strict();

const StoreSchema = z.object({
  version: z.literal(1),
  publications: z.array(PublicationRecordSchema).max(128),
}).strict();

export type LocalSkillPublicationRecord = z.infer<typeof PublicationRecordSchema>;

const unavailable = () => new RemoteInstanceError(
  "local_io_failure",
  "Runtime Skill publication state is unavailable or invalid.",
);

async function publicationStoreInfo(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unavailable();
  }
}

function safePublicationStoreInfo(info: Awaited<ReturnType<typeof lstat>>): boolean {
  const permissivePosixMode = process.platform !== "win32" && (Number(info.mode) & 0o077) !== 0;
  return info.isFile() && !info.isSymbolicLink() && !permissivePosixMode && info.size <= 2 * 1024 * 1024;
}

async function parsePublicationStore(path: string): Promise<z.infer<typeof StoreSchema>> {
  try {
    return StoreSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw unavailable();
  }
}

/** Private, atomic record of explicitly confirmed automatic publications. */
export class LocalSkillPublicationStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    if (!isAbsolute(path)) throw unavailable();
  }

  async list(): Promise<LocalSkillPublicationRecord[]> {
    return this.exclusive(async () => structuredClone((await this.read()).publications));
  }

  async save(recordValue: z.input<typeof PublicationRecordSchema>): Promise<void> {
    const record = PublicationRecordSchema.parse(structuredClone(recordValue));
    await this.exclusive(async () => {
      const store = await this.read();
      const existing = store.publications.findIndex(row => row.localId === record.localId);
      const publications = [...store.publications];
      if (existing >= 0) publications[existing] = record;
      else if (publications.length < 128) publications.push(record);
      else throw unavailable();
      await this.write({ version: 1, publications });
    });
  }

  async updateDigest(localId: string, treeDigest: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(localId) || !/^sha256:[a-f0-9]{64}$/.test(treeDigest)) {
      throw unavailable();
    }
    await this.exclusive(async () => {
      const store = await this.read();
      const index = store.publications.findIndex(row => row.localId === localId);
      if (index < 0) throw unavailable();
      const current = store.publications[index]!;
      const publications = [...store.publications];
      publications[index] = { ...current, treeDigest };
      await this.write({ version: 1, publications });
    });
  }

  async markRevoking(localId: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(localId)) throw unavailable();
    await this.exclusive(async () => {
      const store = await this.read();
      const index = store.publications.findIndex(row => row.localId === localId);
      if (index < 0) throw unavailable();
      const publications = [...store.publications];
      publications[index] = { ...publications[index]!, revoking: true };
      await this.write({ version: 1, publications });
    });
  }

  async remove(localId: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(localId)) throw unavailable();
    return this.exclusive(async () => {
      const store = await this.read();
      const publications = store.publications.filter(row => row.localId !== localId);
      if (publications.length === store.publications.length) return false;
      await this.write({ version: 1, publications });
      return true;
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<z.infer<typeof StoreSchema>> {
    const info = await publicationStoreInfo(this.path);
    if (!info) return { version: 1, publications: [] };
    if (!safePublicationStoreInfo(info)) throw unavailable();
    return parsePublicationStore(this.path);
  }

  private async write(value: unknown): Promise<void> {
    try {
      await writeSecretFile(this.path, `${JSON.stringify(StoreSchema.parse(value))}\n`);
    } catch {
      throw unavailable();
    }
  }
}

export type { LocalSkillPublication };
