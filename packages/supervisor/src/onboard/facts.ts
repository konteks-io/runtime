import { DiscoveryEvidenceFactsSchema, type DiscoveryEvidenceFacts } from "@konteks/remote-common";
import type { EvidenceCandidate } from "./evidence-paths.js";

/**
 * Fact extraction (OB6 §2, invariant 2: Konteks receives evidence, never code).
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
  const handles = new Set<string>();
  const manifests: NonNullable<DiscoveryEvidenceFacts["manifests"]> = [];
  const workspaces = new Set<string>();
  const release: NonNullable<DiscoveryEvidenceFacts["release"]> = [];
  let monorepo = false;
  let descriptor: DiscoveryEvidenceFacts["descriptor"];

  for (const file of files) {
    const text = file.body.toString("utf8");
    switch (file.candidate.family) {
      case "codeowners":
        for (const handle of parseCodeowners(text)) if (handles.size < MAX_HANDLES) handles.add(handle);
        break;
      case "manifest": {
        const manifest = parseManifest(file.candidate.path, text);
        if (manifest) manifests.push(manifest);
        if (file.candidate.path === "package.json") {
          for (const pattern of packageJsonWorkspaces(text)) {
            if (workspaces.size < MAX_WORKSPACES) workspaces.add(pattern);
          }
          if (workspaces.size > 0) monorepo = true;
        }
        break;
      }
      case "workspace": {
        for (const pattern of workspacePatterns(file.candidate.path, text)) {
          if (workspaces.size < MAX_WORKSPACES) workspaces.add(pattern);
        }
        monorepo = true;
        break;
      }
      case "release":
        release.push({ kind: releaseKind(file.candidate.path) });
        break;
      case "descriptor": {
        const found = parseDescriptor(text);
        if (found) descriptor = found;
        break;
      }
    }
  }

  const facts: DiscoveryEvidenceFacts = {
    ...(handles.size > 0 ? { codeowners: { handles: [...handles] } } : {}),
    ...(manifests.length > 0 ? { manifests: manifests.slice(0, 64) } : {}),
    ...(workspaces.size > 0 || monorepo ? { layout: { monorepo, ...(workspaces.size > 0 ? { workspaces: [...workspaces] } : {}) } } : {}),
    ...(descriptor ? { descriptor } : {}),
    ...(release.length > 0 ? { release: release.slice(0, 32) } : {}),
  };
  // Parse our own output: the schema is the boundary that keeps a body out.
  return DiscoveryEvidenceFactsSchema.parse(facts);
}

/**
 * CODEOWNERS handles only. Patterns are deliberately dropped: a path pattern is
 * a fact about the repository's layout that nobody asked for, and the owner
 * mapping (ON9) works on handles.
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

function parseManifest(path: string, text: string): { kind: string; name?: string; dependencies?: string[] } | null {
  switch (path) {
    case "package.json": {
      const json = safeJson(text);
      if (!json) return null;
      const name = typeof json.name === "string" ? json.name : undefined;
      const dependencies = [...dependencyNames(json.dependencies), ...dependencyNames(json.devDependencies), ...dependencyNames(json.peerDependencies)];
      return { kind: "npm", ...(name ? { name } : {}), ...(dependencies.length ? { dependencies: dependencies.slice(0, MAX_DEPENDENCIES) } : {}) };
    }
    case "pyproject.toml": {
      const name = /^\s*name\s*=\s*["']([^"']{1,256})["']/m.exec(text)?.[1];
      const dependencies = [...text.matchAll(/^\s*["']([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:[<>=!~\[][^"']*)?["']\s*,?\s*$/gm)].map(match => match[1]!);
      return { kind: "python", ...(name ? { name } : {}), ...(dependencies.length ? { dependencies: dependencies.slice(0, MAX_DEPENDENCIES) } : {}) };
    }
    case "go.mod": {
      const name = /^module\s+(\S{1,256})/m.exec(text)?.[1];
      const dependencies = [...text.matchAll(/^\s*(\S+)\s+v\d+\.\S+/gm)].map(match => match[1]!).filter(value => value !== "go" && value !== "toolchain");
      return { kind: "go", ...(name ? { name } : {}), ...(dependencies.length ? { dependencies: dependencies.slice(0, MAX_DEPENDENCIES) } : {}) };
    }
    case "Cargo.toml": {
      const name = /^\s*name\s*=\s*["']([^"']{1,256})["']/m.exec(text)?.[1];
      const section = /\[dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(text)?.[1] ?? "";
      const dependencies = [...section.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*=/gm)].map(match => match[1]!);
      return { kind: "cargo", ...(name ? { name } : {}), ...(dependencies.length ? { dependencies: dependencies.slice(0, MAX_DEPENDENCIES) } : {}) };
    }
    case "pom.xml": {
      const name = /<artifactId>([^<]{1,256})<\/artifactId>/.exec(text)?.[1];
      const dependencies = [...text.matchAll(/<dependency>[\s\S]*?<artifactId>([^<]{1,256})<\/artifactId>/g)].map(match => match[1]!.trim());
      return { kind: "maven", ...(name ? { name } : {}), ...(dependencies.length ? { dependencies: dependencies.slice(0, MAX_DEPENDENCIES) } : {}) };
    }
    default:
      if (!path.endsWith(".csproj")) return null;
      return {
        kind: "dotnet",
        name: path.split("/").pop()!.replace(/\.csproj$/, ""),
        ...(() => {
          const dependencies = [...text.matchAll(/<PackageReference\s+Include="([^"]{1,256})"/g)].map(match => match[1]!);
          return dependencies.length ? { dependencies: dependencies.slice(0, MAX_DEPENDENCIES) } : {};
        })(),
      };
  }
}

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
