import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";
import {
  RemoteFileTreeSchema, RemoteSkillCatalogSchema, RemoteTransferBindingSchema,
  REMOTE_FILE_TREE_LIMITS, RemoteInstanceError, computeRemoteFileTreeDigest,
  computeRemoteTransferManifestDigest, validateRemoteTransfer, sha256Hex,
  canonicalize, isFsErrorWithCode,
  type RemoteTransferBinding, type RemoteTransferManifest, type RemoteSkillCatalog,
  type RemoteFileEntry, type RemoteFileTree,
} from "@konteks/remote-common";

/**
 * Content-addressed private staging follows bb's injected-skills pattern:
 * build a temporary complete catalog and atomically rename it. The staging
 * directory is keyed by WHAT the skills are (id, version, name, tree digest),
 * never by which assignment asked for them: an organization's skills change
 * rarely, so a tree fetched once is reused by every later turn, and reuse
 * still revalidates the complete tree on disk against the CURRENT manifest
 * (`validateRemoteTransfer` checks tree content by digest) and the current
 * authority. Keying by assignment staged identical catalogs once per turn —
 * 38 copies of the same skills on one connector — and fetched every one.
 * See THIRD_PARTY_NOTICES.md and proof/BB-REUSE.md for attribution.
 */
export interface StageOrganizationSkillsOptions {
  scratchRoot: string;
  catalog: unknown;
  /** Obtained from the current authorized assignment, not a received catalog. */
  authority: { binding: RemoteTransferBinding; catalogDigest: string };
  /** Checks live claim, lease, policy, and revocation. Called again before commit/reuse. */
  assertAuthorized: () => Promise<void>;
  /** Uses assignment-scoped artifact access; never an arbitrary URL fetch. */
  fetchTree: (manifest: RemoteTransferManifest) => Promise<unknown>;
  now: () => number;
}

export interface StagedOrganizationSkills {
  root: string;
  catalogDigest: string;
  skills: Array<{ skillId: string; version: string; name: string; description: string; directory: string; skillFile: string }>;
}

const unavailable = () => new RemoteInstanceError("capability_unavailable", "Required organization skills could not be staged safely.");
/** What a catalog IS, independent of the assignment that carries it. */
function skillContentIdentity(catalog: RemoteSkillCatalog): string {
  return sha256Hex(canonicalize(
    [...catalog.skills].sort((a, b) => a.skillId.localeCompare(b.skillId))
      .map(s => ({ skillId: s.skillId, version: s.version, name: s.name, treeDigest: s.transfer.treeDigest })),
  ));
}
const invalidRoot = () => new RemoteInstanceError("local_io_failure", "Organization skill staging requires a private connector-owned directory.");
const ReceiptSchema = z.object({
  catalog: RemoteSkillCatalogSchema,
  modes: z.record(z.string(), z.record(z.string(), z.union([z.literal(0o600), z.literal(0o700)]))),
}).strict();

function privateNode(stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw unavailable();
  if (process.platform !== "win32" && (directory ? (stat.mode & 0o7777) !== 0o700 : ![0o600, 0o700].includes(stat.mode & 0o7777))) throw unavailable();
}

async function privateRoot(value: string): Promise<string> {
  if (!isAbsolute(value) || resolve(value) === parse(resolve(value)).root || resolve(value) === resolve(homedir())) throw invalidRoot();
  try {
    await mkdir(value, { recursive: true, mode: 0o700 });
    privateNode(await lstat(value), true);
    return await realpath(value);
  } catch { throw invalidRoot(); }
}

async function writePrivate(path: string, bytes: Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); }
  finally { await handle.close(); }
}

/** Read at most the observed size + one byte, rejecting replacement/links/growth. */
async function readPrivate(path: string, maxBytes: number): Promise<{ bytes: Buffer; stat: Stats }> {
  const before = await lstat(path); privateNode(before, false);
  if (before.size > maxBytes) throw unavailable();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat(); privateNode(stat, false);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) throw unavailable();
    const buffer = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    if (count !== stat.size) throw unavailable();
    return { bytes: buffer.subarray(0, count), stat };
  } finally { await handle.close(); }
}

async function readTree(root: string, modes: Record<string, 384 | 448>): Promise<RemoteFileTree> {
  const entries: RemoteFileEntry[] = []; let total = 0;
  async function visit(directory: string, relative: string, depth: number): Promise<void> {
    if (depth > REMOTE_FILE_TREE_LIMITS.depth) throw unavailable();
    privateNode(await lstat(directory), true);
    const names = await readdir(directory);
    if ((relative && names.length === 0) || names.length > REMOTE_FILE_TREE_LIMITS.files) throw unavailable();
    for (const name of names) {
      const path = join(directory, name), wirePath = relative ? `${relative}/${name}` : name;
      const stat = await lstat(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(path, wirePath, depth + 1);
      else {
        if (entries.length >= REMOTE_FILE_TREE_LIMITS.files) throw unavailable();
        const file = await readPrivate(path, REMOTE_FILE_TREE_LIMITS.bytes - total);
        total += file.bytes.length;
        if (!Object.hasOwn(modes, wirePath)) throw unavailable();
        const mode = modes[wirePath]!;
        // Mode metadata is bound by the authorized tree digest, not trusted
        // merely because it is in the receipt. Windows ACL isolation still
        // requires independent installer/service proof on actual Windows.
        if (process.platform !== "win32" && (file.stat.mode & 0o7777) !== mode) throw unavailable();
        entries.push({ path: wirePath, mode, sizeBytes: file.bytes.length, digest: `sha256:${sha256Hex(file.bytes)}`, contentBase64: file.bytes.toString("base64") });
      }
    }
  }
  await visit(root, "", 0);
  if (entries.length !== Object.keys(modes).length) throw unavailable();
  return { format: "konteks-file-tree-v1", entries, treeDigest: computeRemoteFileTreeDigest(entries) };
}

function result(root: string, catalog: RemoteSkillCatalog): StagedOrganizationSkills {
  return {
    root, catalogDigest: catalog.catalogDigest,
    skills: catalog.skills.map(skill => {
      const directory = join(root, skill.name);
      return { skillId: skill.skillId, version: skill.version, name: skill.name, description: skill.description, directory, skillFile: join(directory, "SKILL.md") };
    }),
  };
}

async function current(options: StageOrganizationSkillsOptions, catalog: RemoteSkillCatalog): Promise<void> {
  await options.assertAuthorized();
  const now = options.now();
  if (!Number.isFinite(now) || catalog.skills.some(s => Date.parse(s.transfer.expiresAt) <= now)) throw unavailable();
}

async function verifyCatalog(root: string, catalog: RemoteSkillCatalog, now: number): Promise<void> {
  privateNode(await lstat(root), true);
  const actual = (await readdir(root)).sort();
  const expected = [".catalog.json", ...catalog.skills.map(s => s.name)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw unavailable();
  const receipt = await readPrivate(join(root, ".catalog.json"), 16 * 1024 * 1024);
  const parsed = ReceiptSchema.safeParse(JSON.parse(receipt.bytes.toString("utf8")));
  // The receipt's catalog was written by whichever assignment staged first;
  // the trees are identified by content, and each is revalidated below against
  // the manifest of THIS assignment, so the assignment-scoped fields differ.
  if (!parsed.success || skillContentIdentity(parsed.data.catalog) !== skillContentIdentity(catalog) || JSON.stringify(Object.keys(parsed.data.modes).sort()) !== JSON.stringify(catalog.skills.map(s => s.name).sort())) throw unavailable();
  for (const skill of catalog.skills) {
    const tree = await readTree(join(root, skill.name), parsed.data.modes[skill.name]!);
    if (!tree.entries.some(e => e.path === "SKILL.md")) throw unavailable();
    if (!validateRemoteTransfer(skill.transfer, tree, { binding: catalog.binding, manifestDigest: computeRemoteTransferManifestDigest(skill.transfer), now }).valid) throw unavailable();
  }
}

export async function stageOrganizationSkills(options: StageOrganizationSkillsOptions): Promise<StagedOrganizationSkills> {
  const parsed = RemoteSkillCatalogSchema.safeParse(options.catalog);
  const authority = RemoteTransferBindingSchema.safeParse(options.authority.binding);
  if (!parsed.success || !authority.success || canonicalize(parsed.data.binding) !== canonicalize(authority.data) || parsed.data.catalogDigest !== options.authority.catalogDigest) {
    throw new RemoteInstanceError("workspace_binding_invalid", "Organization skill selection does not match the authorized assignment.");
  }
  const catalog = parsed.data;
  try { await current(options, catalog); } catch { throw unavailable(); }
  const scratch = await privateRoot(options.scratchRoot);
  const name = `skills-${skillContentIdentity(catalog)}`;
  const destination = join(scratch, name);
  let exists = true;
  try { await lstat(destination); } catch (error) { if (isFsErrorWithCode(error, "ENOENT")) exists = false; else throw unavailable(); }
  if (exists) {
    try { await verifyCatalog(destination, catalog, options.now()); await current(options, catalog); return result(destination, catalog); }
    catch { throw unavailable(); }
  }
  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(join(scratch, ".stage-"));
    await chmod(temporary, 0o700);
    const modes: Array<[string, Record<string, 384 | 448>]> = [];
    for (const skill of catalog.skills) {
      const data = await options.fetchTree(skill.transfer);
      if (!validateRemoteTransfer(skill.transfer, data, { binding: authority.data, manifestDigest: computeRemoteTransferManifestDigest(skill.transfer), now: options.now() }).valid) throw unavailable();
      const tree = RemoteFileTreeSchema.parse(data);
      if (!tree.entries.some(e => e.path === "SKILL.md")) throw unavailable();
      modes.push([skill.name, Object.fromEntries(tree.entries.map(entry => [entry.path, entry.mode]))]);
      for (const entry of tree.entries) await writePrivate(join(temporary, skill.name, ...entry.path.split("/")), Buffer.from(entry.contentBase64, "base64"), entry.mode);
    }
    await writePrivate(join(temporary, ".catalog.json"), Buffer.from(JSON.stringify({ catalog, modes: Object.fromEntries(modes) })));
    await verifyCatalog(temporary, catalog, options.now());
    await current(options, catalog);
    try { await rename(temporary, destination); temporary = undefined; }
    catch (error) {
      if (!isFsErrorWithCode(error, "EEXIST") && !isFsErrorWithCode(error, "ENOTEMPTY")) throw error;
      // Another caller won the same immutable catalog. Never overwrite it.
      await verifyCatalog(destination, catalog, options.now());
    }
    await current(options, catalog);
    return result(destination, catalog);
  } catch { throw unavailable(); }
  finally {
    // Only the exact mkdtemp child created by this call is eligible for cleanup.
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
