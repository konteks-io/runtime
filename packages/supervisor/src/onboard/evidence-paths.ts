import type { CatalogLearningEvidenceKind } from "@konteks/remote-common";

/**
 * The conventional single-file reads a `grouping` pass may make (OB6 §2).
 *
 * The list is CLOSED and ordered. Closed, because the collector never reads a
 * file it cannot name in `refs` — a wildcard would let a run read whatever it
 * found. Ordered, because `bounds.maxFilesPerRepository` truncates it: a
 * repository that allows eight reads should spend them on the descriptor and
 * the ownership file before the changelog.
 */
export interface EvidenceCandidate {
  path: string;
  kind: CatalogLearningEvidenceKind;
  /** Which fact family this file feeds, for the extractor. */
  family: "descriptor" | "codeowners" | "manifest" | "workspace" | "release";
}

const STATIC_CANDIDATES: readonly EvidenceCandidate[] = [
  { path: "catalog-info.yaml", kind: "catalog-descriptor", family: "descriptor" },
  // The three conventional CODEOWNERS locations, in the order git forges
  // themselves resolve them.
  { path: ".github/CODEOWNERS", kind: "codeowners", family: "codeowners" },
  { path: "CODEOWNERS", kind: "codeowners", family: "codeowners" },
  { path: "docs/CODEOWNERS", kind: "codeowners", family: "codeowners" },
  { path: "package.json", kind: "project-manifest", family: "manifest" },
  { path: "pyproject.toml", kind: "project-manifest", family: "manifest" },
  { path: "go.mod", kind: "project-manifest", family: "manifest" },
  { path: "Cargo.toml", kind: "project-manifest", family: "manifest" },
  { path: "pom.xml", kind: "project-manifest", family: "manifest" },
  { path: "pnpm-workspace.yaml", kind: "workspace-manifest", family: "workspace" },
  { path: "lerna.json", kind: "workspace-manifest", family: "workspace" },
  { path: "nx.json", kind: "workspace-manifest", family: "workspace" },
  { path: ".goreleaser.yml", kind: "release-signal", family: "release" },
  { path: ".github/workflows/release.yml", kind: "release-signal", family: "release" },
  { path: ".releaserc", kind: "release-signal", family: "release" },
];

/**
 * CONTRACT-GAP: OB6 §2 names `*.csproj` among the manifest roots, but a
 * `grouping` pass has no file listing — it reads named paths and never clones,
 * so a glob cannot be resolved. The two conventional spellings derived from the
 * repository's own name are read instead; a solution laid out some other way is
 * found at `deep` depth, where there is a checkout to look at.
 */
export function evidenceCandidates(repoName: string, limit: number): EvidenceCandidate[] {
  const project = repoName.replace(/[^A-Za-z0-9._-]/g, "");
  const csproj: EvidenceCandidate[] = project
    ? [
        { path: `${project}.csproj`, kind: "project-manifest", family: "manifest" },
        { path: `src/${project}/${project}.csproj`, kind: "project-manifest", family: "manifest" },
      ]
    : [];
  const ordered = [
    ...STATIC_CANDIDATES.filter(candidate => candidate.family === "descriptor" || candidate.family === "codeowners"),
    ...STATIC_CANDIDATES.filter(candidate => candidate.family === "manifest"),
    ...csproj,
    ...STATIC_CANDIDATES.filter(candidate => candidate.family === "workspace"),
    ...STATIC_CANDIDATES.filter(candidate => candidate.family === "release"),
  ];
  return ordered.slice(0, Math.max(0, limit));
}
