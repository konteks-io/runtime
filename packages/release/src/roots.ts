import { readFile } from "node:fs/promises";
import { z } from "zod";
import { EmbeddedReleaseRootSchema, type EmbeddedReleaseRoot } from "./manifest.js";

/**
 * The launcher embeds only PUBLIC release roots. The release pipeline injects
 * the production roots into the signed launcher at build time; a launcher
 * built without roots verifies nothing and therefore installs nothing
 * (`bundle_untrusted`), which is the intended fail-closed default.
 */
const RootsFileSchema = z.object({ roots: z.array(EmbeddedReleaseRootSchema) }).strict();

export const EMBEDDED_RELEASE_ROOTS: readonly EmbeddedReleaseRoot[] = Object.freeze(
  parseEmbeddedRoots(process.env.KONTEKS_RELEASE_ROOTS_JSON),
);

export function parseEmbeddedRoots(json: string | undefined): EmbeddedReleaseRoot[] {
  if (!json) return [];
  return RootsFileSchema.parse(JSON.parse(json)).roots;
}

export async function loadReleaseRootsFile(path: string): Promise<EmbeddedReleaseRoot[]> {
  return RootsFileSchema.parse(JSON.parse(await readFile(path, "utf8"))).roots;
}
