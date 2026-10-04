import { createHash } from "node:crypto";
import { z } from "zod";
import { RemoteInstanceError, RemoteTransferPathSchema, type RemoteNativeArtifact } from "@konteks/remote-common";
import { findAgentBridge } from "./bridges.js";
import { BROWSER_MCP_PACKAGE, BROWSER_MCP_LAUNCHER_PATH } from "./browser.js";

export const OFFLINE_AGENT_PROFILE_FILE = "konteks-agent.json";
export const OFFLINE_AGENT_LIMITS = Object.freeze({ files: 20_000, bytes: 1024 ** 3, profileBytes: 4 * 1024 ** 2 });
const pathSchema = RemoteTransferPathSchema.refine(path => Buffer.byteLength(path, "utf8") <= 240);
const exactVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const entrypoint = z.object({ package: z.string().min(1).max(128), version: exactVersion, entrypoint: pathSchema, runtime: z.enum(["native", "node"]) }).strict();
const toolingPackages = { "claude-code": "@anthropic-ai/claude-code", codex: "@openai/codex" } as const;

const NativeAgentPackageProfileObjectSchema = z.object({
  schemaVersion: z.literal(1), agentId: z.enum(["claude-code", "codex"]),
  os: z.enum(["macos", "windows", "debian"]), architecture: z.enum(["amd64", "arm64"]),
  bridge: entrypoint, tooling: entrypoint,
  codexLocalProxy: z.object({ version: z.literal(1), entrypoint: pathSchema }).strict().optional(),
  /** The bundled browser MCP server (Playwright MCP) and the connector's launcher that runs it. */
  browser: z.object({ package: z.literal(BROWSER_MCP_PACKAGE.package), version: exactVersion, entrypoint: pathSchema, launcher: pathSchema, runtime: z.literal("node") }).strict().optional(),
  node: z.object({ version: z.literal("22.23.2"), entrypoint: pathSchema }).strict().optional(),
  files: z.array(z.object({ path: pathSchema, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), sizeBytes: z.number().int().min(0).max(OFFLINE_AGENT_LIMITS.bytes), executable: z.boolean() }).strict()).min(1).max(OFFLINE_AGENT_LIMITS.files),
}).strict();
type ProfileShape = z.infer<typeof NativeAgentPackageProfileObjectSchema>;
type ProfileCommand = ProfileShape["bridge"];
type Fail = (message: string) => void;

/** Local release-package format, not another cloud execution protocol. */
export const NativeAgentPackageProfileSchema = NativeAgentPackageProfileObjectSchema.superRefine((profile, ctx) => {
  const fail: Fail = message => ctx.addIssue({ code: "custom", message });
  checkPackageIdentity(profile, fail);
  checkInventory(profile.files, fail);
  for (const command of [profile.bridge, profile.tooling]) checkCommand(profile, command, fail);
  checkBundledNode(profile, fail);
  checkBrowser(profile, fail);
  checkCodexLocalProxy(profile, fail);
});

function checkPackageIdentity(profile: ProfileShape, fail: Fail): void {
  const family = findAgentBridge(profile.agentId)!;
  if (profile.bridge.package !== family.package || profile.bridge.version !== family.version || profile.tooling.package !== toolingPackages[profile.agentId]) fail("package identity does not match the pinned agent family");
}

/** Sorted, unique under case folding, no file where a directory is, and within the total byte limit. */
function checkInventory(files: ProfileShape["files"], fail: Fail): void {
  const seen = new Set<string>(), directories = new Map<string, string>();
  let previous = "", total = 0;
  for (const file of files) {
    const folded = file.path.toLowerCase();
    if (file.path <= previous || folded === OFFLINE_AGENT_PROFILE_FILE || seen.has(folded) || directories.has(folded)) fail("package inventory must be uniquely sorted");
    recordParentDirectories(file.path, seen, directories, fail);
    seen.add(folded); previous = file.path; total += file.sizeBytes;
  }
  if (total > OFFLINE_AGENT_LIMITS.bytes) fail("package exceeds total byte limit");
}

function recordParentDirectories(path: string, seen: ReadonlySet<string>, directories: Map<string, string>, fail: Fail): void {
  const parts = path.split("/");
  for (let length = 1; length < parts.length; length++) {
    const parent = parts.slice(0, length).join("/");
    const foldedParent = parent.toLowerCase(), existing = directories.get(foldedParent);
    if (seen.has(foldedParent) || existing !== undefined && existing !== parent) fail("package path collision");
    directories.set(foldedParent, parent);
  }
}

function checkCommand(profile: ProfileShape, command: ProfileCommand, fail: Fail): void {
  if (!commandInventoried(profile, command)) fail("command entrypoint is not an inventoried executable");
  if (command.runtime === "node" && !profile.node) fail("node command requires a bundled runtime");
  if (command.runtime === "native" && profile.os === "windows" && !command.entrypoint.endsWith(".exe")) fail("Windows native entrypoints require .exe");
}

function commandInventoried(profile: ProfileShape, command: ProfileCommand): boolean {
  const file = profile.files.find(candidate => candidate.path === command.entrypoint);
  return file !== undefined && (command.runtime !== "native" || file.executable);
}

function checkBundledNode(profile: ProfileShape, fail: Fail): void {
  if (!profile.node) return;
  const node = profile.node;
  const file = profile.files.find(candidate => candidate.path === node.entrypoint);
  if (!file?.executable || profile.os === "windows" && !node.entrypoint.endsWith(".exe")) fail("bundled Node is not an inventoried executable");
}

function checkBrowser(profile: ProfileShape, fail: Fail): void {
  if (!profile.browser) return;
  const { entrypoint: cli, launcher, version } = profile.browser;
  if (version !== BROWSER_MCP_PACKAGE.version || launcher !== BROWSER_MCP_LAUNCHER_PATH || !profile.node ||
      ![cli, launcher].every(path => profile.files.some(candidate => candidate.path === path))) fail("browser MCP server must be the pinned, inventoried package with its launcher and bundled Node");
}

function checkCodexLocalProxy(profile: ProfileShape, fail: Fail): void {
  if (!profile.codexLocalProxy) return;
  const proxy = profile.codexLocalProxy;
  const file = profile.files.find(candidate => candidate.path === proxy.entrypoint);
  if (profile.agentId !== "codex" || profile.os === "windows" || !profile.node || !file?.executable) fail("Codex local proxy requires an inventoried Unix executable and bundled Node");
}

export type NativeAgentPackageProfile = z.infer<typeof NativeAgentPackageProfileSchema>;

export function readNativeAgentProfile(bytes: Buffer, artifact: RemoteNativeArtifact): NativeAgentPackageProfile {
  if (artifact.format !== "offline_agent_tgz" || artifact.kind !== "agent_bridge" || bytes.length > OFFLINE_AGENT_LIMITS.profileBytes || sha256(bytes) !== artifact.profileDigest) throw offlinePackageInvalid();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const profile = NativeAgentPackageProfileSchema.parse(JSON.parse(text));
  if (profile.agentId !== artifact.agentId || profile.os !== artifact.os || profile.architecture !== artifact.architecture) throw offlinePackageInvalid();
  return profile;
}

function sha256(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
export function offlinePackageInvalid() { return new RemoteInstanceError("bundle_untrusted", "The offline agent package or its complete signed dependency inventory is invalid."); }
