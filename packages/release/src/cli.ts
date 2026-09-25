#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { ed25519PrivateKeyFromJwk, generateEd25519 } from "@konteks/remote-common";
import { signNativeProductionReleaseManifest, verifyNativeRelease } from "./native.js";
import { loadReleaseRootsFile } from "./roots.js";

/**
 * `konteks-release`: the release-tooling stub used by CI. It signs and
 * verifies the exact native manifest consumed by the launcher. It has no
 * appliance/image signing command.
 */
const program = new Command("konteks-release").description("Konteks Remote Instance release tooling");

program
  .command("sign-native")
  .description("sign an unsigned native connector manifest")
  .requiredOption("--manifest <path>")
  .requiredOption("--key <path>", "private Ed25519 JWK")
  .requiredOption("--key-id <id>")
  .requiredOption("--out <path>")
  .action(async (options: { manifest: string; key: string; keyId: string; out: string }) => {
    const unsigned = JSON.parse(await readFile(options.manifest, "utf8")) as Record<string, unknown>;
    delete unsigned.digest;
    delete unsigned.signature;
    const privateKey = ed25519PrivateKeyFromJwk(JSON.parse(await readFile(options.key, "utf8")));
    const signed = signNativeProductionReleaseManifest(
      unsigned as never,
      { keyId: options.keyId, privateKey },
    );
    await writeFile(options.out, `${JSON.stringify(signed, null, 2)}\n`);
    process.stdout.write(`signed native connector ${options.manifest} -> ${options.out} (digest ${signed.digest})\n`);
  });

program
  .command("verify-native")
  .description("verify a native connector manifest against a roots file")
  .requiredOption("--manifest <path>")
  .requiredOption("--roots <path>")
  .action(async (options: { manifest: string; roots: string }) => {
    const roots = await loadReleaseRootsFile(options.roots);
    const release = verifyNativeRelease(JSON.parse(await readFile(options.manifest, "utf8")), roots, Date.now());
    process.stdout.write(`ok: native connector ${release.manifest.bundleVersion} digest ${release.manifest.digest}\n`);
  });

program
  .command("keygen")
  .description("generate an Ed25519 release signing keypair (private JWK to --out, public root to --root-out)")
  .requiredOption("--key-id <id>")
  .requiredOption("--out <path>")
  .requiredOption("--root-out <path>")
  .action(async (options: { keyId: string; out: string; rootOut: string }) => {
    const { privateKey, publicJwk } = generateEd25519();
    await writeFile(options.out, JSON.stringify(privateKey.export({ format: "jwk" })), { mode: 0o600 });
    await writeFile(
      options.rootOut,
      `${JSON.stringify({ roots: [{ keyId: options.keyId, publicKeyJwk: publicJwk }] }, null, 2)}\n`,
    );
    process.stdout.write(`wrote private key to ${options.out} and public root to ${options.rootOut}\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
