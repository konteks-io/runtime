#!/usr/bin/env node
/** Publish only a locally verified native manifest and its exact artifacts. */
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1]] : []).filter(pair => pair.length === 2));
const channel = args.channel ?? "stable", upload = process.env.KONTEKS_RELEASE_UPLOAD_CMD;
if (!upload || !args.manifest || !args.dist || !args.bootstrap) throw new Error("publish requires upload command, manifest, dist, and bootstrap");
execFileSync("npx", ["tsx", "packages/release/src/cli.ts", "verify-native", "--manifest", args.manifest, "--roots", "release/roots.json"], { stdio: "inherit" });
const manifest = JSON.parse(readFileSync(args.manifest, "utf8")), files = walk(args.dist);
const put = (local, remote) => execFileSync("sh", ["-c", `${upload} "$1" "$2"`, "--", local, remote], { stdio: "inherit" });

put(args.manifest, `${channel}/native-manifest.json`);
for (const artifact of manifest.nativeArtifacts) {
  const expectedTail = `/native/${artifact.os}/${artifact.architecture}/${basename(new URL(artifact.url).pathname)}`;
  const matches = files.filter(path => path.replaceAll("\\", "/").endsWith(expectedTail));
  if (matches.length !== 1) throw new Error(`cannot uniquely locate ${artifact.id}`);
  const marker = "/remote-instance/", pathname = new URL(artifact.url).pathname;
  const offset = pathname.indexOf(marker);
  if (offset < 0) throw new Error(`artifact URL is outside the release namespace: ${artifact.id}`);
  put(matches[0], pathname.slice(offset + marker.length));
}
for (const path of files) if (/konteks-remote(?:-|_).+\.(?:pkg|msi|deb|asc)$/.test(basename(path))) put(path, `${channel}/launcher/${basename(path)}`);
for (const name of ["SHA256SUMS", "SHA256SUMS.sig", "release-signing.pub"]) {
  const matches = files.filter(path => basename(path) === name);
  if (matches.length !== 1) throw new Error(`cannot uniquely locate ${name}`);
  put(matches[0], `${channel}/launcher/${name}`);
}
put(join(args.bootstrap, "install.sh"), "bootstrap/v1/install.sh");
put(join(args.bootstrap, "install.ps1"), "bootstrap/v1/install.ps1");
console.log(`published native ${channel}`);

function walk(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
