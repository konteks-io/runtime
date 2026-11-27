import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";
import {
  RemoteFileTreeSchema, RemoteSkillCatalogSchema, RemoteTransferBindingSchema,
  REMOTE_FILE_TREE_LIMITS, computeRemoteFileTreeDigest,
  computeRemoteTransferManifestDigest, validateRemoteTransfer, sha256Hex,
  canonicalize, isFsErrorWithCode,
  type RemoteTransferBinding, type RemoteTransferManifest, type RemoteSkillCatalog,
  type RemoteFileEntry, type RemoteFileTree,
} from "@konteks/remote-common";
import { readFully } from "../read-fully.js";
import { innerDiagnostic, LoggedRefusal } from "../native/named-refusal.js";

/**
 * Content-addressed private staging follows bb's injected-skills pattern:
 * build a temporary complete catalog and atomically rename it. The staging
 * directory is keyed by WHAT the skills are (id, version, name, tree digest),
 * never by which assignment asked for them: an organization's skills change
 * rarely, so a tree fetched once is reused by every later turn, and reuse
 * still revalidates the complete tree on disk against the CURRENT manifest
 * (`validateRemoteTransfer` checks tree content by digest) and the current
 * authority. Keying by assignment would stage and fetch an identical catalog
 * once per turn. See THIRD_PARTY_NOTICES.md for attribution.
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

/** Each refusal names its check; identifiers only, never paths, skill names or provider text. */
const unavailable = (diagnostic: string) => new LoggedRefusal("capability_unavailable", "Required organization skills could not be staged safely.", diagnostic);
/** What a catalog IS, independent of the assignment that carries it. */
function skillContentIdentity(catalog: RemoteSkillCatalog): string {
  return sha256Hex(canonicalize(
    [...catalog.skills].sort((a, b) => a.skillId.localeCompare(b.skillId))
      .map(s => ({ skillId: s.skillId, version: s.version, name: s.name, treeDigest: s.transfer.treeDigest })),
  ));
}
const invalidRoot = (diagnostic: string) => new LoggedRefusal("local_io_failure", "Organization skill staging requires a private connector-owned directory.", diagnostic);
const ReceiptSchema = z.object({
  catalog: RemoteSkillCatalogSchema,
  modes: z.record(z.string(), z.record(z.string(), z.union([z.literal(0o600), z.literal(0o700)]))),
}).strict();

function privateNode(stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw unavailable("skill_entry_wrong_kind");
  if (process.platform !== "win32" && (directory ? (stat.mode & 0o7777) !== 0o700 : ![0o600, 0o700].includes(stat.mode & 0o7777))) throw unavailable("skill_entry_not_private");
}

async function privateRoot(value: string): Promise<string> {
  if (!isAbsolute(value) || resolve(value) === parse(resolve(value)).root || resolve(value) === resolve(homedir())) throw invalidRoot("skill_root_path_invalid");
  try {
    await mkdir(value, { recursive: true, mode: 0o700 });
    privateNode(await lstat(value), true);
    return await realpath(value);
  } catch (error) { throw invalidRoot(innerDiagnostic(error, "skill_root_unavailable")); }
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
  if (before.size > maxBytes) throw unavailable("skill_file_too_large");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat(); privateNode(stat, false);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) throw unavailable("skill_file_replaced");
    const buffer = Buffer.alloc(stat.size + 1);
    const count = await readFully(handle, buffer);
    if (count !== stat.size) throw unavailable("skill_file_short_read");
    return { bytes: buffer.subarray(0, count), stat };
  } finally { await handle.close(); }
}

/** Reads a staged skill tree back, bounded by the file-tree limits and the receipt's modes. */
class TreeReader {
  readonly entries: RemoteFileEntry[] = [];
  private total = 0;

  constructor(private readonly modes: Record<string, 384 | 448>) {}

  async visit(directory: string, relative: string, depth: number): Promise<void> {
    for (const name of await this.listChildren(directory, relative, depth)) {
      const path = join(directory, name), wirePath = relative ? `${relative}/${name}` : name;
      const stat = await lstat(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await this.visit(path, wirePath, depth + 1);
      else await this.readEntry(path, wirePath);
    }
  }

  private async listChildren(directory: string, relative: string, depth: number): Promise<string[]> {
    if (depth > REMOTE_FILE_TREE_LIMITS.depth) throw unavailable("skill_tree_too_deep");
    privateNode(await lstat(directory), true);
    const names = await readdir(directory);
    if ((relative && names.length === 0) || names.length > REMOTE_FILE_TREE_LIMITS.files) throw unavailable("skill_directory_entry_count_invalid");
    return names;
  }

  private async readEntry(path: string, wirePath: string): Promise<void> {
    if (this.entries.length >= REMOTE_FILE_TREE_LIMITS.files) throw unavailable("skill_tree_too_many_files");
    const file = await readPrivate(path, REMOTE_FILE_TREE_LIMITS.bytes - this.total);
    this.total += file.bytes.length;
    if (!Object.hasOwn(this.modes, wirePath)) throw unavailable("skill_file_not_in_receipt");
    const mode = this.modes[wirePath]!;
    // Mode metadata is bound by the authorized tree digest, not trusted
    // merely because it is in the receipt. Windows ACL isolation still
    // requires independent installer/service proof on actual Windows.
    if (process.platform !== "win32" && (file.stat.mode & 0o7777) !== mode) throw unavailable("skill_file_mode_changed");
    this.entries.push({ path: wirePath, mode, sizeBytes: file.bytes.length, digest: `sha256:${sha256Hex(file.bytes)}`, contentBase64: file.bytes.toString("base64") });
  }
}

async function readTree(root: string, modes: Record<string, 384 | 448>): Promise<RemoteFileTree> {
  const reader = new TreeReader(modes);
  await reader.visit(root, "", 0);
  if (reader.entries.length !== Object.keys(modes).length) throw unavailable("skill_tree_file_count_mismatch");
  return { format: "konteks-file-tree-v1", entries: reader.entries, treeDigest: computeRemoteFileTreeDigest(reader.entries) };
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
  if (!Number.isFinite(now) || catalog.skills.some(s => Date.parse(s.transfer.expiresAt) <= now)) throw unavailable("skill_transfer_expired");
}

async function verifyCatalog(root: string, catalog: RemoteSkillCatalog, now: number): Promise<void> {
  privateNode(await lstat(root), true);
  const actual = (await readdir(root)).sort();
  const expected = [".catalog.json", ...catalog.skills.map(s => s.name)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw unavailable("skill_catalog_entries_mismatch");
  const receipt = await readPrivate(join(root, ".catalog.json"), 16 * 1024 * 1024);
  const parsed = ReceiptSchema.safeParse(JSON.parse(receipt.bytes.toString("utf8")));
  // The receipt's catalog was written by whichever assignment staged first;
  // the trees are identified by content, and each is revalidated below against
  // the manifest of THIS assignment, so the assignment-scoped fields differ.
  if (!parsed.success || skillContentIdentity(parsed.data.catalog) !== skillContentIdentity(catalog) || JSON.stringify(Object.keys(parsed.data.modes).sort()) !== JSON.stringify(catalog.skills.map(s => s.name).sort())) throw unavailable("skill_catalog_receipt_mismatch");
  for (const skill of catalog.skills) {
    const tree = await readTree(join(root, skill.name), parsed.data.modes[skill.name]!);
    if (!tree.entries.some(e => e.path === "SKILL.md")) throw unavailable("skill_staged_tree_missing_skill_md");
    if (!validateRemoteTransfer(skill.transfer, tree, { binding: catalog.binding, manifestDigest: computeRemoteTransferManifestDigest(skill.transfer), now }).valid) throw unavailable("skill_staged_tree_invalid");
  }
}

export async function stageOrganizationSkills(options: StageOrganizationSkillsOptions): Promise<StagedOrganizationSkills> {
  const { catalog, binding } = authorizedCatalog(options);
  try { await current(options, catalog); } catch (error) { throw unavailable(innerDiagnostic(error, "skill_authorization_failed")); }
  const scratch = await privateRoot(options.scratchRoot);
  const destination = join(scratch, `skills-${skillContentIdentity(catalog)}`);
  if (await stagedAlready(destination)) return reuseStaged(destination, catalog, options);
  return stageFresh(scratch, destination, { catalog, binding }, options);
}

type AuthorizedCatalog = { catalog: RemoteSkillCatalog; binding: RemoteTransferBinding };

function authorizedCatalog(options: StageOrganizationSkillsOptions): AuthorizedCatalog {
  const parsed = RemoteSkillCatalogSchema.safeParse(options.catalog);
  const authority = RemoteTransferBindingSchema.safeParse(options.authority.binding);
  if (!parsed.success || !authority.success || canonicalize(parsed.data.binding) !== canonicalize(authority.data) || parsed.data.catalogDigest !== options.authority.catalogDigest) {
    throw new LoggedRefusal("workspace_binding_invalid", "Organization skill selection does not match the authorized assignment.", "skill_catalog_binding_mismatch");
  }
  return { catalog: parsed.data, binding: authority.data };
}

async function stagedAlready(destination: string): Promise<boolean> {
  try {
    await lstat(destination);
    return true;
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return false;
    throw unavailable("skill_destination_unreadable");
  }
}

async function reuseStaged(destination: string, catalog: RemoteSkillCatalog, options: StageOrganizationSkillsOptions): Promise<StagedOrganizationSkills> {
  try { await verifyCatalog(destination, catalog, options.now()); await current(options, catalog); return result(destination, catalog); }
  catch (error) { throw unavailable(innerDiagnostic(error, "skill_reuse_failed")); }
}

async function stageFresh(scratch: string, destination: string, authorized: AuthorizedCatalog, options: StageOrganizationSkillsOptions): Promise<StagedOrganizationSkills> {
  const { catalog } = authorized;
  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(join(scratch, ".stage-"));
    await chmod(temporary, 0o700);
    await writeSkills(temporary, authorized, options);
    await verifyCatalog(temporary, catalog, options.now());
    await current(options, catalog);
    if (await publishStaged(temporary, destination, catalog, options)) temporary = undefined;
    await current(options, catalog);
    return result(destination, catalog);
  } catch (error) { throw unavailable(innerDiagnostic(error, "skill_stage_failed")); }
  finally {
    // Only the exact mkdtemp child created by this call is eligible for cleanup.
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeSkills(temporary: string, { catalog, binding }: AuthorizedCatalog, options: StageOrganizationSkillsOptions): Promise<void> {
  const modes: Array<[string, Record<string, 384 | 448>]> = [];
  for (const skill of catalog.skills) {
    const tree = await fetchedSkillTree(skill.transfer, binding, options);
    modes.push([skill.name, Object.fromEntries(tree.entries.map(entry => [entry.path, entry.mode]))]);
    for (const entry of tree.entries) await writePrivate(join(temporary, skill.name, ...entry.path.split("/")), Buffer.from(entry.contentBase64, "base64"), entry.mode);
  }
  await writePrivate(join(temporary, ".catalog.json"), Buffer.from(JSON.stringify({ catalog, modes: Object.fromEntries(modes) })));
}

async function fetchedSkillTree(manifest: RemoteTransferManifest, binding: RemoteTransferBinding, options: StageOrganizationSkillsOptions): Promise<RemoteFileTree> {
  const data = await options.fetchTree(manifest);
  if (!validateRemoteTransfer(manifest, data, { binding, manifestDigest: computeRemoteTransferManifestDigest(manifest), now: options.now() }).valid) throw unavailable("skill_transfer_invalid");
  const tree = RemoteFileTreeSchema.parse(data);
  if (!tree.entries.some(e => e.path === "SKILL.md")) throw unavailable("skill_transfer_missing_skill_md");
  return tree;
}

/**
 * Renames the staged catalog into place: true once it moved. Another caller
 * that won the same immutable catalog is verified, never overwritten.
 */
async function publishStaged(temporary: string, destination: string, catalog: RemoteSkillCatalog, options: StageOrganizationSkillsOptions): Promise<boolean> {
  try {
    await rename(temporary, destination);
    return true;
  } catch (error) {
    if (!isFsErrorWithCode(error, "EEXIST") && !isFsErrorWithCode(error, "ENOTEMPTY")) throw error;
    await verifyCatalog(destination, catalog, options.now());
    return false;
  }
}
