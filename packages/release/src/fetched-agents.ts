import { z } from "zod";
import pins from "./fetched-agents.json" with { type: "json" };

/**
 * The pins of the agents the connector fetches itself:
 * per platform, the vendor's archive URL, its size and sha256, the
 * size and sha256 of every file it unpacks to, the command and arguments the
 * vendor's registry entry names, and the signer the OS must confirm. The file
 * is reviewed like the host model mappings and travels inside the connector
 * executable, whose digest the signed release manifest carries: only a
 * runtime release changes a pin, and the connector never follows the vendor's
 * registry on its own. A platform without a pin is not offered there.
 */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const size = z.number().int().positive().max(4 * 1024 ** 3);
/** A plain relative path inside the archive: no absolute path, no `.`/`..`, no backslash, no control character. */
const archivePath = z.string().min(1).max(255)
  .refine(value => !/[\p{Cc}\p{Cf}\p{Cs}\\:]/u.test(value) && !value.startsWith("/")
    && value.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".."));

export const FetchedAgentSignerSchema = z.discriminatedUnion("kind", [
  /** macOS: `codesign --verify --strict` under Apple's anchor with this Team ID. */
  z.object({ kind: z.literal("apple_team_id"), teamId: z.string().regex(/^[A-Z0-9]{10}$/) }).strict(),
  /** Windows: Authenticode status `Valid` with exactly this signer subject. */
  z.object({ kind: z.literal("authenticode"), subject: z.string().min(1).max(512) }).strict(),
  /** Linux: no OS signature; the pinned hashes are the whole check. */
  z.object({ kind: z.literal("none") }).strict(),
]);
export type FetchedAgentSigner = z.infer<typeof FetchedAgentSignerSchema>;

export const FetchedAgentPlatformPinSchema = z.object({
  url: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }),
  archive: z.object({ format: z.literal("zip"), size, sha256 }).strict(),
  /** The executable the registry's `cmd` names, relative to the unpacked folder. */
  command: archivePath,
  args: z.array(z.string().max(256).refine(value => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value))).max(8),
  /** Every file the archive holds; nothing else may be in it. */
  files: z.array(z.object({ path: archivePath, size, sha256 }).strict()).min(1).max(16),
  signer: FetchedAgentSignerSchema,
}).strict().refine(pin => pin.files.some(file => file.path === pin.command), "the command must be a pinned file")
  .refine(pin => new Set(pin.files.map(file => file.path.toLowerCase())).size === pin.files.length, "file paths must be unique");
export type FetchedAgentPlatformPin = z.infer<typeof FetchedAgentPlatformPinSchema>;

/** `<process.platform>-<process.arch>`, e.g. `darwin-arm64`, `linux-x64`, `win32-arm64`. */
export const FETCHED_AGENT_PLATFORM_KEYS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"] as const;
export type FetchedAgentPlatformKey = (typeof FETCHED_AGENT_PLATFORM_KEYS)[number];

const FetchedAgentPinSchema = z.object({
  agentId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  /** Where the vendor publishes the archive list (the weekly canary reads it; the connector never does). */
  source: z.string().url(),
  registryId: z.string().min(1).max(128),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  terms: z.string().url(),
  platforms: z.partialRecord(z.enum(FETCHED_AGENT_PLATFORM_KEYS), FetchedAgentPlatformPinSchema),
}).strict();
type FetchedAgentPin = z.infer<typeof FetchedAgentPinSchema>;

const FetchedAgentPinsSchema = z.object({
  schemaVersion: z.literal(1),
  agents: z.array(FetchedAgentPinSchema).max(8).refine(agents => new Set(agents.map(agent => agent.agentId)).size === agents.length),
}).strict();

/** The pins this runtime release carries (parsed once; a malformed file fails the build's tests, never a person's machine silently). */
export const FETCHED_AGENT_PINS: readonly FetchedAgentPin[] = Object.freeze(FetchedAgentPinsSchema.parse(pins).agents.map(pin => deepFreeze(pin)));

/** The pin of a fetched agent, if this release carries one. */
export function fetchedAgentPin(agentId: string): FetchedAgentPin | undefined {
  return FETCHED_AGENT_PINS.find(pin => pin.agentId === agentId);
}

/** This computer's platform key, or null for a platform no fetched agent could ever run on. */
export function fetchedAgentPlatformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): FetchedAgentPlatformKey | null {
  const key = `${platform}-${arch}`;
  return (FETCHED_AGENT_PLATFORM_KEYS as readonly string[]).includes(key) ? key as FetchedAgentPlatformKey : null;
}

/** The pinned archive of `agentId` for a platform, or undefined when this release carries none for it. */
export function fetchedAgentPlatformPin(agentId: string, key: FetchedAgentPlatformKey | null = fetchedAgentPlatformKey()): FetchedAgentPlatformPin | undefined {
  return key === null ? undefined : fetchedAgentPin(agentId)?.platforms[key];
}

/** The folder a pinned version unpacks to, under `<connector root>/agents/<agentId>/`: `<version>-<platform key>`. */
export function fetchedAgentFolderName(pin: Pick<FetchedAgentPin, "version">, key: FetchedAgentPlatformKey): string {
  return `${pin.version}-${key}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
