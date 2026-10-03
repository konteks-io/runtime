import { DiscoveryEvidenceFactsSchema, type DiscoveryEvidenceFacts } from "@konteks/remote-common";
import type { EvidenceCandidate } from "./evidence-paths.js";

/**
 * Fact extraction: Konteks receives evidence, never code.
 *
 * Everything here runs on the customer's machine and returns only the small
 * closed shape `DiscoveryEvidenceFacts` names. No file body is kept, no line is
 * quoted, and a file we cannot parse contributes nothing rather than a
 * best-effort guess — a wrong fact is worse than a missing one, because a
 * person reviewing the portfolio cannot see that it was invented.
 */

export interface ReadFile {
  candidate: EvidenceCandidate;
  body: Buffer;
}

const MAX_HANDLES = 256;
const MAX_DEPENDENCIES = 512;
const MAX_WORKSPACES = 256;

export function extractFacts(files: readonly ReadFile[]): DiscoveryEvidenceFacts {
  const draft = new FactsDraft();
  for (const file of files) FAMILY_READERS[file.candidate.family](draft, file.candidate.path, file.body.toString("utf8"));
  // Parse our own output: the schema is the boundary that keeps a body out.
  return DiscoveryEvidenceFactsSchema.parse(draft.facts());
}

type Manifest = NonNullable<DiscoveryEvidenceFacts["manifests"]>[number];

/** The facts gathered so far from one repository's files. */
class FactsDraft {
  readonly handles = new Set<string>();
  readonly manifests: Manifest[] = [];
  readonly workspaces = new Set<string>();
  readonly release: NonNullable<DiscoveryEvidenceFacts["release"]> = [];
  monorepo = false;
  descriptor: DiscoveryEvidenceFacts["descriptor"];

  addWorkspaces(patterns: Iterable<string>): void {
    for (const pattern of patterns) if (this.workspaces.size < MAX_WORKSPACES) this.workspaces.add(pattern);
  }

  facts(): DiscoveryEvidenceFacts {
    return {
      ...(this.handles.size > 0 ? { codeowners: { handles: [...this.handles] } } : {}),
      ...(this.manifests.length > 0 ? { manifests: this.manifests.slice(0, 64) } : {}),
      ...this.layout(),
      ...(this.descriptor ? { descriptor: this.descriptor } : {}),
      ...(this.release.length > 0 ? { release: this.release.slice(0, 32) } : {}),
    };
  }

  private layout(): Pick<DiscoveryEvidenceFacts, "layout"> {
    if (this.workspaces.size === 0 && !this.monorepo) return {};
    return { layout: { monorepo: this.monorepo, ...(this.workspaces.size > 0 ? { workspaces: [...this.workspaces] } : {}) } };
  }
}

/** What each family of evidence file adds to the draft. */
const FAMILY_READERS: Record<ReadFile["candidate"]["family"], (draft: FactsDraft, path: string, text: string) => void> = {
  codeowners: (draft, _path, text) => {
    for (const handle of parseCodeowners(text)) if (draft.handles.size < MAX_HANDLES) draft.handles.add(handle);
  },
  manifest: (draft, path, text) => {
    const manifest = parseManifest(path, text);
    if (manifest) draft.manifests.push(manifest);
    if (path !== "package.json") return;
    draft.addWorkspaces(packageJsonWorkspaces(text));
    if (draft.workspaces.size > 0) draft.monorepo = true;
  },
  workspace: (draft, path, text) => {
    draft.addWorkspaces(workspacePatterns(path, text));
    draft.monorepo = true;
  },
  release: (draft, path) => {
    draft.release.push({ kind: releaseKind(path) });
  },
  descriptor: (draft, _path, text) => {
    const found = parseDescriptor(text);
    if (found) draft.descriptor = found;
  },
};
/**
 * CODEOWNERS handles only. Patterns are deliberately dropped: a path pattern is
 * a fact about the repository's layout that nobody asked for, and the owner
 * mapping works on handles.
 */
export function parseCodeowners(text: string): string[] {
  const handles: string[] = [];
  for (const rawLine of text.split("\n").slice(0, 2_000)) {
    const line = rawLine.split("#")[0]!.trim();
    if (!line) continue;
    for (const token of line.split(/\s+/).slice(1)) {
      if (/^@[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(token) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(token)) handles.push(token);
    }
  }
  return handles;
}

function parseManifest(path: string, text: string): Manifest | null {
  const parse = MANIFEST_PARSERS.get(path);
  if (parse) return parse(text);
  if (!path.endsWith(".csproj")) return null;
  const dependencies = [...text.matchAll(/<PackageReference\s+Include="([^"]{1,256})"/g)].map(match => match[1]!);
  return { kind: "dotnet", name: path.split("/").pop()!.replace(/\.csproj$/, ""), ...dependencyField(dependencies) };
}

function manifest(kind: string, name: string | undefined, dependencies: string[]): Manifest {
  return { kind, ...(name ? { name } : {}), ...dependencyField(dependencies) };
}

function dependencyField(dependencies: string[]): { dependencies?: string[] } {
  return dependencies.length ? { dependencies: dependencies.slice(0, MAX_DEPENDENCIES) } : {};
}

const NAME_LINE = /^\s*name\s*=\s*["']([^"']{1,256})["']/m;

/** Each manifest file's kind, name and dependency names; null when it does not parse. */
const MANIFEST_PARSERS = new Map<string, (text: string) => Manifest | null>([
  ["package.json", text => {
    const json = safeJson(text);
    if (!json) return null;
    const dependencies = [...dependencyNames(json.dependencies), ...dependencyNames(json.devDependencies), ...dependencyNames(json.peerDependencies)];
    return manifest("npm", typeof json.name === "string" ? json.name : undefined, dependencies);
  }],
  ["pyproject.toml", text => manifest(
    "python",
    NAME_LINE.exec(text)?.[1],
    [...text.matchAll(/^\s*["']([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:[<>=!~[][^"']*)?["']\s*,?\s*$/gm)].map(match => match[1]!),
  )],
  ["go.mod", text => manifest(
    "go",
    /^module\s+(\S{1,256})/m.exec(text)?.[1],
    [...text.matchAll(/^\s*(\S+)\s+v\d+\.\S+/gm)].map(match => match[1]!).filter(value => value !== "go" && value !== "toolchain"),
  )],
  ["Cargo.toml", text => {
    const section = /\[dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(text)?.[1] ?? "";
    return manifest("cargo", NAME_LINE.exec(text)?.[1], [...section.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*=/gm)].map(match => match[1]!));
  }],
  ["pom.xml", text => manifest(
    "maven",
    /<artifactId>([^<]{1,256})<\/artifactId>/.exec(text)?.[1],
    [...text.matchAll(/<dependency>[\s\S]*?<artifactId>([^<]{1,256})<\/artifactId>/g)].map(match => match[1]!.trim()),
  )],
]);
function packageJsonWorkspaces(text: string): string[] {
  const json = safeJson(text);
  if (!json) return [];
  const value = json.workspaces;
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (value && typeof value === "object" && Array.isArray((value as { packages?: unknown }).packages)) {
    return ((value as { packages: unknown[] }).packages).filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function workspacePatterns(path: string, text: string): string[] {
  if (path === "pnpm-workspace.yaml") {
    // A deliberately small YAML read: the `packages:` sequence and nothing
    // else. Pulling in a YAML parser to learn four globs is not worth the
    // dependency, and anything this shape cannot read simply contributes no
    // pattern — the `monorepo` flag still lands.
    const section = /^packages:[ \t]*\n([\s\S]*?)(?=\n\S|$)/m.exec(text)?.[1] ?? "";
    return [...section.matchAll(/^\s*-\s*["']?([^"'\s#]{1,512})["']?\s*$/gm)].map(match => match[1]!);
  }
  if (path === "lerna.json" || path === "nx.json") {
    const json = safeJson(text);
    const packages = json?.packages;
    return Array.isArray(packages) ? packages.filter((entry): entry is string => typeof entry === "string") : [];
  }
  return [];
}

function releaseKind(path: string): string {
  if (path === ".goreleaser.yml") return "goreleaser";
  if (path === ".releaserc") return "semantic-release";
  return "release-workflow";
}

/**
 * A Backstage catalog descriptor names the System and Component outright, which
 * makes it the most authoritative single file a repository can carry. Only the
 * two names are lifted; the rest of the descriptor is the catalog's business
 * and belongs to the review, not the scan.
 */
export function parseDescriptor(text: string): { systemName?: string; componentName?: string } | null {
  const systemName = /^\s*system:\s*["']?([^"'\s#]{1,256})["']?\s*$/m.exec(text)?.[1];
  const componentName = /^\s*name:\s*["']?([^"'\s#]{1,256})["']?\s*$/m.exec(text)?.[1];
  if (!systemName && !componentName) return null;
  return { ...(systemName ? { systemName } : {}), ...(componentName ? { componentName } : {}) };
}

function dependencyNames(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : [];
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
