import { randomUUID } from "node:crypto";
import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  captureRetainedProcessOwner,
  readDarwinProcessIdentity,
  readLinuxProcessIdentity,
  stopRetainedProcessOwner,
  RemoteInstanceError,
  type RetainedProcessOwner,
  type ProcessIdentity,
} from "@konteks/remote-common";

/** A failed capture remains a reservation; a PID alone never authorizes a signal. */
export interface PreviewProcessOwner {
  version: 2;
  id: string;
  pid: number | null;
  platform: NodeJS.Platform;
  process: RetainedProcessOwner | null;
}

export function capturePreviewProcessOwner(pid: number | undefined): PreviewProcessOwner {
  const record: PreviewProcessOwner = {
    version: 2,
    id: randomUUID(),
    pid: pid ?? null,
    platform: process.platform,
    process: null,
  };
  try {
    record.process = captureRetainedProcessOwner(pid ?? 0);
  } catch {
    /* The reservation survives missing or uncertain identity. */
  }
  return record;
}

/** Only ESRCH establishes POSIX group absence, including for a legacy record. */
export function previewGroupAbsent(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  observe: (group: number) => void = (group) => {
    process.kill(-group, 0);
  },
): boolean {
  if (platform !== process.platform || (platform !== "darwin" && platform !== "linux"))
    return false;
  try {
    observe(pid);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw cleanupRequired("The preview process group could not be observed.");
  }
}

export async function stopPreviewProcessOwner(record: PreviewProcessOwner): Promise<void> {
  const owner = record.process;
  if (!owner) {
    if (record.pid !== null && previewGroupAbsent(record.pid, record.platform)) return;
    throw cleanupRequired(
      "The preview's original process identity was not captured; cleanup remains unconfirmed.",
    );
  }
  if (owner.platform === "win32") return stopRetainedProcessOwner(owner);
  // A shell may legitimately exec the dev server. Kernel start identity and
  // group membership remain authority; an executable label is not PID reuse.
  await stopRetainedProcessOwner(owner, { readIdentity: (pid) => readPreviewIdentity(owner, pid) });
}

export function readPreviewIdentity(
  owner: RetainedProcessOwner,
  pid: number,
  read: (pid: number) => ProcessIdentity | null = owner.platform === "darwin"
    ? readDarwinProcessIdentity
    : readLinuxProcessIdentity,
): ProcessIdentity | null {
  const current = read(pid);
  if (
    !current ||
    current.pid !== owner.pid ||
    current.processGroupId !== owner.processGroupId ||
    current.startToken !== owner.startToken
  )
    return current;
  return { ...current, commandDigest: owner.commandDigest };
}

export function cleanupRequired(message: string): RemoteInstanceError {
  return new RemoteInstanceError("recovery_required", message);
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1;
}

function retainedOwner(value: unknown): value is RetainedProcessOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as RetainedProcessOwner;
  return validOwnerPosition(owner) && validOwnerLabels(owner);
}

function validOwnerPosition(owner: RetainedProcessOwner): boolean {
  return (
    owner.version === 1 &&
    validPid(owner.pid) &&
    owner.processGroupId === owner.pid &&
    ["darwin", "linux", "win32"].includes(owner.platform)
  );
}

function validOwnerLabels(owner: RetainedProcessOwner): boolean {
  return (
    typeof owner.startToken === "string" &&
    owner.startToken.length > 0 &&
    typeof owner.commandDigest === "string" &&
    owner.commandDigest.length > 0
  );
}

function registryRecord(value: unknown): PreviewProcessOwner {
  if (!value || typeof value !== "object")
    throw cleanupRequired("The preview registry contains an invalid owner.");
  const row = value as Record<string, unknown>;
  if (row.version !== 2) return legacyRecord(row);
  return modernRecord(row);
}

function modernRecord(row: Record<string, unknown>): PreviewProcessOwner {
  const validProcess = row.process === null || retainedOwner(row.process);
  if (!validEnvelope(row) || !validProcess)
    throw cleanupRequired("The preview registry contains an invalid owner.");
  const record = row as unknown as PreviewProcessOwner;
  if (
    record.process &&
    (record.pid !== record.process.pid || record.platform !== record.process.platform)
  )
    throw cleanupRequired("The preview registry has conflicting process identities.");
  return record;
}

function validEnvelope(row: Record<string, unknown>): boolean {
  return (
    typeof row.id === "string" &&
    Boolean(row.id) &&
    typeof row.platform === "string" &&
    (row.pid === null || validPid(row.pid))
  );
}

function legacyRecord(row: Record<string, unknown>): PreviewProcessOwner {
  if (!validPid(row.pid) || typeof row.token !== "string" || !row.token)
    throw cleanupRequired("The preview registry contains an invalid legacy owner.");
  // Old PID/start-label records cannot authorize the new exact-owner stop.
  // They remain fenced unless their POSIX group is independently absent.
  return {
    version: 2,
    id: `legacy:${row.pid}`,
    pid: row.pid,
    platform: process.platform,
    process: null,
  };
}

interface RegistryOptions {
  stop?: (owner: PreviewProcessOwner) => Promise<void>;
}

/** A restart never adopts a preview. Unconfirmed owners survive every sweep. */
export class PreviewProcessRegistry {
  private readonly records = new Map<string, PreviewProcessOwner>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly options: RegistryOptions = {},
  ) {}

  retain(owner: PreviewProcessOwner): Promise<void> {
    return this.mutate(async () => {
      this.records.set(owner.id, owner);
      await writeRegistry(this.file, [...this.records.values()]);
    });
  }

  async forget(owner: PreviewProcessOwner): Promise<void> {
    await this.mutate(async () => {
      if (this.records.get(owner.id) !== owner)
        throw cleanupRequired("The preview registry owner changed before retirement.");
      this.records.delete(owner.id);
      try {
        await writeRegistry(this.file, [...this.records.values()]);
      } catch (error) {
        this.records.set(owner.id, owner);
        throw error;
      }
    });
  }

  async sweep(): Promise<number> {
    const previous = await this.previousRecords();
    for (const owner of previous) {
      if (this.records.has(owner.id))
        throw cleanupRequired("The preview registry contains duplicate owners.");
      this.records.set(owner.id, owner);
    }
    const failures: unknown[] = [];
    let stopped = 0;
    for (const owner of previous) {
      try {
        await (this.options.stop ?? stopPreviewProcessOwner)(owner);
        await this.forget(owner);
        stopped++;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Leftover preview cleanup remains unconfirmed; startup is fenced.",
      );
    return stopped;
  }

  private async previousRecords(): Promise<PreviewProcessOwner[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let rows: unknown;
    try {
      rows = JSON.parse(text);
    } catch {
      throw cleanupRequired("The preview registry is malformed; startup is fenced.");
    }
    if (!Array.isArray(rows)) throw cleanupRequired("The preview registry is not an owner list.");
    return rows.map(registryRecord);
  }

  private mutate(task: () => Promise<void>): Promise<void> {
    // Both the mutation and its snapshot are serialized. A failed retirement
    // restores its owner before another write can omit that reservation.
    this.writing = this.writing.catch(() => undefined).then(task);
    return this.writing;
  }
}

async function writeRegistry(file: string, rows: PreviewProcessOwner[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(rows));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
