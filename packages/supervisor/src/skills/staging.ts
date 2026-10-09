import { RuntimeSkillSyncEnvelopeSchema, RuntimeSkillSyncCatalogSchema, type RuntimeSkillSyncItem } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";
import {
  RemoteFileTreeSchema, RemoteSkillCatalogSchema, RemoteTransferBindingSchema,
  REMOTE_FILE_TREE_LIMITS, RemoteInstanceError, computeRemoteFileTreeDigest,
  computeRemoteTransferManifestDigest, validateRemoteTransfer, sha256Hex,
  canonicalize, isFsErrorWithCode, skillScopeAllows,
  type SkillExecutionContext,
  type RemoteTransferBinding, type RemoteTransferManifest, type RemoteSkillCatalog,
  type RemoteFileEntry, type RemoteFileTree,
} from "@konteks/remote-common";
import { readFully } from "../read-fully.js";

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
  /** Core-resolved execution identity, never inferred from local paths or Skill content. */
  executionContext?: SkillExecutionContext;
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
  skills: Array<{ skillId: string; version: string; name: string; description: string; directory: string; skillFile: string; treeDigest: string; fileModes: Record<string, 384 | 448> }>;
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
    const buffer = Buffer.alloc(stat.size + 1);
    const count = await readFully(handle, buffer);
    if (count !== stat.size) throw unavailable();
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
    if (depth > REMOTE_FILE_TREE_LIMITS.depth) throw unavailable();
    privateNode(await lstat(directory), true);
    const names = await readdir(directory);
    if ((relative && names.length === 0) || names.length > REMOTE_FILE_TREE_LIMITS.files) throw unavailable();
    return names;
  }

  private async readEntry(path: string, wirePath: string): Promise<void> {
    if (this.entries.length >= REMOTE_FILE_TREE_LIMITS.files) throw unavailable();
    const file = await readPrivate(path, REMOTE_FILE_TREE_LIMITS.bytes - this.total);
    this.total += file.bytes.length;
    if (!Object.hasOwn(this.modes, wirePath)) throw unavailable();
    const mode = this.modes[wirePath]!;
    // Mode metadata is bound by the authorized tree digest, not trusted
    // merely because it is in the receipt. Windows ACL isolation still
    // requires independent installer/service proof on actual Windows.
    if (process.platform !== "win32" && (file.stat.mode & 0o7777) !== mode) throw unavailable();
    this.entries.push({ path: wirePath, mode, sizeBytes: file.bytes.length, digest: `sha256:${sha256Hex(file.bytes)}`, contentBase64: file.bytes.toString("base64") });
  }
}

async function readTree(root: string, modes: Record<string, 384 | 448>): Promise<RemoteFileTree> {
  const reader = new TreeReader(modes);
  await reader.visit(root, "", 0);
  if (reader.entries.length !== Object.keys(modes).length) throw unavailable();
  return { format: "konteks-file-tree-v1", entries: reader.entries, treeDigest: computeRemoteFileTreeDigest(reader.entries) };
}

function result(root: string, catalog: RemoteSkillCatalog, modes: Record<string, Record<string, 384 | 448>>): StagedOrganizationSkills {
  return {
    root, catalogDigest: catalog.catalogDigest,
    skills: catalog.skills.map(skill => {
      const directory = join(root, skill.name);
      return { skillId: skill.skillId, version: skill.version, name: skill.name, description: skill.description, directory, skillFile: join(directory, "SKILL.md"), treeDigest: skill.transfer.treeDigest, fileModes: { ...modes[skill.name] } };
    }),
  };
}

async function current(options: StageOrganizationSkillsOptions, catalog: RemoteSkillCatalog): Promise<void> {
  await options.assertAuthorized();
  const now = options.now();
  if (!Number.isFinite(now) || catalog.skills.some(s => Date.parse(s.transfer.expiresAt) <= now)) throw unavailable();
}

async function verifyCatalog(root: string, catalog: RemoteSkillCatalog, now: number): Promise<Record<string, Record<string, 384 | 448>>> {
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
  return parsed.data.modes;
}

export async function stageOrganizationSkills(options: StageOrganizationSkillsOptions): Promise<StagedOrganizationSkills> {
  const { catalog, binding } = authorizedCatalog(options);
  try { await current(options, catalog); } catch { throw unavailable(); }
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
    throw new RemoteInstanceError("workspace_binding_invalid", "Organization skill selection does not match the authorized assignment.");
  }
  if (parsed.data.skills.some(skill => skill.scope && !skillScopeAllows(skill.scope, parsed.data.executionContext ?? options.executionContext))) {
    throw new RemoteInstanceError("workspace_binding_invalid", "A required Skill is outside this execution scope.");
  }
  return { catalog: parsed.data, binding: authority.data };
}

async function stagedAlready(destination: string): Promise<boolean> {
  try {
    await lstat(destination);
    return true;
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return false;
    throw unavailable();
  }
}

async function reuseStaged(destination: string, catalog: RemoteSkillCatalog, options: StageOrganizationSkillsOptions): Promise<StagedOrganizationSkills> {
  try { const modes = await verifyCatalog(destination, catalog, options.now()); await current(options, catalog); return result(destination, catalog, modes); }
  catch { throw unavailable(); }
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
    return result(destination, catalog, await verifyCatalog(destination, catalog, options.now()));
  } catch { throw unavailable(); }
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
  if (!validateRemoteTransfer(manifest, data, { binding, manifestDigest: computeRemoteTransferManifestDigest(manifest), now: options.now() }).valid) throw unavailable();
  const tree = RemoteFileTreeSchema.parse(data);
  if (!tree.entries.some(e => e.path === "SKILL.md")) throw unavailable();
  return tree;
}

/**
 * Windows can report access denied when rename encounters an existing directory.
 * A matching error is only a reason to verify the destination, never success.
 */
function mayHaveExistingDestination(error: unknown): boolean {
  if (isFsErrorWithCode(error, "EEXIST") || isFsErrorWithCode(error, "ENOTEMPTY")) return true;
  return process.platform === "win32" && (isFsErrorWithCode(error, "EACCES") || isFsErrorWithCode(error, "EPERM"));
}

async function publishStaged(temporary: string, destination: string, catalog: RemoteSkillCatalog, options: StageOrganizationSkillsOptions): Promise<boolean> {
  try {
    await rename(temporary, destination);
    return true;
  } catch (error) {
    if (!mayHaveExistingDestination(error)) throw error;
    await verifyCatalog(destination, catalog, options.now());
    return false;
  }
}

/** Machine snapshots never manufacture assignment or claim authority. */
export async function stageMachineOrganizationSkills(options: {
  scratchRoot: string; envelope: unknown;
  owner: { workspaceId: string; instanceId: string };
  /** Verifies the signed envelope and asks Core for fresh live machine authorization. */
  assertAuthorized: () => Promise<void>;
  fetchTree: (skill: RuntimeSkillSyncItem) => Promise<unknown>;
  now: () => number;
}): Promise<StagedOrganizationSkills> {
  const envelope = RuntimeSkillSyncEnvelopeSchema.parse(structuredClone(options.envelope));
  const catalog = envelope.catalog;
  verifyMachineOwner(catalog.binding, options.owner);
  verifyGeneralDiscoveryScopes(catalog.skills);
  const current = async () => {
    await options.assertAuthorized(); const now = options.now();
    if (!Number.isFinite(now) || Date.parse(envelope.issuedAt) > now + 1000 || Date.parse(envelope.expiresAt) <= now) throw unavailable();
  };
  const contentIdentity = (value: typeof catalog) => sha256Hex(canonicalize(JSON.parse(JSON.stringify({
    workspaceId: value.binding.workspaceId, instanceId: value.binding.instanceId, skills: value.skills,
  }))));
  const receiptSchema = z.object({ catalog: RuntimeSkillSyncCatalogSchema,
    modes: z.record(z.string(), z.record(z.string(), z.union([z.literal(0o600), z.literal(0o700)]))),
  }).strict();
  const validate = (skill: RuntimeSkillSyncItem, value: unknown) => {
    const tree = RemoteFileTreeSchema.parse(value);
    if (tree.treeDigest !== skill.treeDigest || tree.entries.length !== skill.fileCount || tree.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0) !== skill.sizeBytes || !tree.entries.some(entry => entry.path === "SKILL.md")) throw unavailable();
    return tree;
  };
  const verify = async (root: string) => {
    privateNode(await lstat(root), true);
    if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify([".catalog.json", ...catalog.skills.map(skill => skill.name)].sort())) throw unavailable();
    const receipt = receiptSchema.parse(JSON.parse((await readPrivate(join(root, ".catalog.json"), 16 * 1024 * 1024)).bytes.toString("utf8")));
    if (contentIdentity(receipt.catalog) !== contentIdentity(catalog) || JSON.stringify(Object.keys(receipt.modes).sort()) !== JSON.stringify(catalog.skills.map(skill => skill.name).sort())) throw unavailable();
    for (const skill of catalog.skills) validate(skill, await readTree(join(root, skill.name), receipt.modes[skill.name]!));
    return receipt.modes;
  };
  let temporary: string | undefined;
  try {
    await current(); const scratch = await privateRoot(options.scratchRoot);
    const destination = join(scratch, `machine-skills-${contentIdentity(catalog)}`);
    if (!await stagedAlready(destination)) {
      temporary = await mkdtemp(join(scratch, ".machine-stage-")); await chmod(temporary, 0o700);
      const modes: Record<string, Record<string, 384 | 448>> = {};
      for (const skill of catalog.skills) {
        const tree = validate(skill, await options.fetchTree(skill));
        modes[skill.name] = Object.fromEntries(tree.entries.map(entry => [entry.path, entry.mode]));
        for (const entry of tree.entries) await writePrivate(join(temporary, skill.name, ...entry.path.split("/")), Buffer.from(entry.contentBase64, "base64"), entry.mode);
      }
      await writePrivate(join(temporary, ".catalog.json"), Buffer.from(JSON.stringify({ catalog, modes })));
      await verify(temporary); await current();
      if (await publishMachineTree(temporary, destination)) temporary = undefined;
    }
    const modes = await verify(destination); await current();
    return { root: destination, catalogDigest: envelope.catalogDigest, skills: catalog.skills.map(skill => {
      const directory = join(destination, skill.name);
      return { skillId: skill.skillId, version: skill.version, name: skill.name, description: skill.description, directory,
        skillFile: join(directory, "SKILL.md"), treeDigest: skill.treeDigest, fileModes: { ...modes[skill.name] } };
    }) };
  } catch { throw unavailable(); }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
}

async function publishMachineTree(temporary: string, destination: string): Promise<boolean> {
  try { await rename(temporary, destination); return true; }
  catch (error) {
    if (!mayHaveExistingDestination(error)) throw error;
    return false;
  }
}

function verifyMachineOwner(binding: { workspaceId: string; instanceId: string }, owner: { workspaceId: string; instanceId: string }): void {
  if (binding.workspaceId !== owner.workspaceId || binding.instanceId !== owner.instanceId) throw unavailable();
}

/** Retain verified full trees under the operator's agent profile. The caller
 * owns and locks the destination parent. Existing content is verified and
 * never overwritten, including a user edit to a previously retained tree. */
export async function verifyRetainedSkillTree(skill: StagedOrganizationSkills["skills"][number], root: string) {
  const tree = RemoteFileTreeSchema.parse(await readTree(root, skill.fileModes));
  if (tree.treeDigest !== skill.treeDigest || !tree.entries.some(e => e.path === "SKILL.md")) throw unavailable();
  return tree;
}

export async function retainStagedSkill(skill: StagedOrganizationSkills["skills"][number], parent: string): Promise<string> {
  const verify = (root: string) => verifyRetainedSkillTree(skill, root);
  const tree = await verify(skill.directory);
  const destination = join(parent, `tree-${sha256Hex(skill.treeDigest)}`);
  try { await lstat(destination); await verify(destination); return destination; }
  catch (error) { if (!isFsErrorWithCode(error, "ENOENT")) throw error; }
  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(join(parent, ".stage-")); await chmod(temporary, 0o700);
    for (const entry of tree.entries) await writePrivate(join(temporary, ...entry.path.split("/")), Buffer.from(entry.contentBase64, "base64"), entry.mode);
    await verify(temporary);
    await rename(temporary, destination); temporary = undefined;
    await verify(destination);
    return destination;
  } catch { throw unavailable(); }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
}

function verifyGeneralDiscoveryScopes(skills: readonly RuntimeSkillSyncItem[]): void {
  if (skills.some(skill => skill.scope !== undefined && (skill.scope.audience.kind !== "organization" || skill.scope.context.kind !== "global"))) throw unavailable();
}
