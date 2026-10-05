/** Select only reviewed native-loader tuples in an offline Graft staging tree. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const loaderVersion = "4.8.4";
const loaderSha256 = "134f0585f7c665db89f332a379158c6f113274422e42aaf54e0aa9d5ac37f577";
const treeSitterRootSha256 = "830fa91de08c3c8348e7f8614ec41b20147f7f4a7491ed944d4a68e15ce89716";
const nodeArchitectures = new Map([["amd64", "x64"], ["arm64", "arm64"]]);
const indexWrapper = `const runtimeRequire = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require // eslint-disable-line
if (typeof runtimeRequire.addon === 'function') { // if the platform supports native resolving prefer that
  module.exports = runtimeRequire.addon.bind(runtimeRequire)
} else { // else use the runtime version here
  module.exports = require('./node-gyp-build.js')
}
`;

export function pruneGraftPrebuilds(directory, target) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Graft staging root is a link");
  const state = { root: realpathSync(directory), target: checkedTarget(target), visited: 0, plans: [] };
  assertEntry(state.root, state.root, "directory");
  discoverPackages(join(state.root, "node_modules"), state, 0);
  if (state.plans.length === 0) throw new Error("No reviewed Graft native prebuild consumers found");
  // Validate every consumer, tuple and removal target before changing any file.
  for (const plan of state.plans) for (const path of plan.paths) assertEntry(state.root, path, "directory");
  for (const plan of state.plans) for (const path of plan.paths) removeTuple(state.root, path);
  return state.plans.map(({ paths: _paths, ...provenance }) => provenance);
}

function removeTuple(root, path) {
  assertEntry(root, path, "directory");
  rmSync(path, { recursive: true });
}

function checkedTarget(target) {
  const arch = nodeArchitectures.get(target.architecture);
  if (!arch || !["darwin", "linux", "win32"].includes(target.platform)) throw new Error("Unsupported native prebuild coordinate");
  return { platform: target.platform, arch };
}

function assertEntry(root, path, kind) {
  const scoped = scopedRelative(root, path);
  let current = root;
  for (const part of scoped.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Native prebuild path is a link: ${current}`);
  }
  const info = lstatSync(path);
  const valid = kind === "directory" ? info.isDirectory() : info.isFile();
  if (!valid || info.isSymbolicLink()) throw new Error(`Native prebuild path is not a regular ${kind}: ${path}`);
}

function scopedRelative(root, path) {
  const scoped = relative(root, resolve(path));
  if (isAbsolute(scoped) || scoped === ".." || scoped.startsWith(`..${sep}`)) throw new Error("Native prebuild path escapes staging root");
  return scoped;
}

function readSource(root, path, maximum = 64 * 1024) {
  assertEntry(root, path, "file");
  if (lstatSync(path).size > maximum) throw new Error("Native loader source exceeds size bound");
  return readFileSync(path);
}

function packageMetadata(root, path) {
  const metadata = JSON.parse(readSource(root, path).toString("utf8"));
  if (typeof metadata.name !== "string" || typeof metadata.version !== "string") throw new Error("Native consumer has no package identity");
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(metadata.name) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(metadata.version)) throw new Error("Invalid native package identity");
  return metadata;
}

function discoverPackages(modules, state, depth) {
  if (depth > 32) throw new Error("Native dependency tree exceeds depth bound");
  assertEntry(state.root, modules, "directory");
  for (const name of readdirSync(modules).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(modules, name);
    assertEntry(state.root, path, "directory");
    if (name.startsWith("@")) discoverScope(path, modules, name, state, depth);
    else discoverPackage(path, modules, name, state, depth);
  }
}

function discoverScope(scope, modules, name, state, depth) {
  for (const member of readdirSync(scope).sort()) discoverPackage(join(scope, member), modules, `${name}/${member}`, state, depth);
}

function discoverPackage(path, modules, name, state, depth) {
  if (++state.visited > 20_000) throw new Error("Native dependency tree exceeds package bound");
  assertEntry(state.root, path, "directory");
  const entries = readdirSync(path);
  if (entries.includes("prebuilds")) state.plans.push(planConsumer(path, modules, name, state));
  if (entries.includes("node_modules")) discoverPackages(join(path, "node_modules"), state, depth + 1);
}

function planConsumer(path, modules, name, state) {
  const metadata = packageMetadata(state.root, join(path, "package.json"));
  if (typeof metadata.dependencies?.["node-gyp-build"] !== "string") throw new Error(`Unreviewed native loader consumer: ${metadata.name}`);
  const entry = createRequire(join(dirname(modules), "konteks-resolution.cjs")).resolve(name);
  assertConsumerEntry(state.root, path, entry, metadata);
  assertLoader(state.root, entry);
  const prebuilds = join(path, "prebuilds");
  const tuples = tuplePlans(state, prebuilds);
  if (!tuples.retained.length && !hasCompiledBinding(state.root, path)) throw new Error(`No target binding for ${metadata.name}`);
  return { package: metadata.name, version: metadata.version, path: relative(state.root, path).split(sep).join("/"), loaderVersion, loaderSha256, ...tuples };
}

function assertConsumerEntry(root, packageRoot, entry, metadata) {
  const bytes = readSource(root, entry);
  if (metadata.name.length > 214 || metadata.version.length > 128) throw new Error("Native consumer identity exceeds context bound");
  try {
    assertConsumerSource(packageRoot, entry, bytes, metadata);
  } catch (cause) {
    const scoped = consumerEntryContext(root, entry);
    throw new Error(`${cause.message}: ${metadata.name}@${metadata.version}, entry ${JSON.stringify(scoped)}`, { cause });
  }
}

function consumerEntryContext(root, entry) {
  const scoped = scopedRelative(root, entry).split(sep).join("/");
  return Buffer.byteLength(scoped, "utf8") <= 4_096 ? scoped : "<staging-relative entry omitted: exceeds 4096 UTF-8 bytes>";
}

function assertConsumerSource(packageRoot, entry, bytes, metadata) {
  const source = bytes.toString("utf8").replaceAll("\r\n", "\n");
  if (/\b(?:function\s+(?:require|__dirname|root)\s*\(|(?:const|let|var)\s+(?:require|__dirname)\b)/.test(source)) throw new Error("Native consumer shadows the reviewed loader context");
  const calls = [...source.matchAll(/require\(['"]node-gyp-build['"]\)\(([^)]+)\)/g)];
  if (calls.length !== 1) throw new Error("Unreviewed native loader call syntax");
  if (calls[0][1] === "__dirname") return assertRootEntry(packageRoot, entry, source, bytes, metadata);
  if (calls[0][1] === "root") return assertGrammarEntry(packageRoot, entry, source);
  throw new Error("Native loader argument does not identify its prebuild root");
}

function assertRootEntry(packageRoot, entry, source, bytes, metadata) {
  const header = /^const binding = require\(['"]node-gyp-build['"]\)\(__dirname\);\n/;
  if (dirname(entry) !== packageRoot) throw new Error("Unreviewed native root entry");
  if (header.test(source) || reviewedTreeSitterRoot(packageRoot, entry, bytes, metadata)) return;
  throw new Error("Unreviewed native root entry");
}

function reviewedTreeSitterRoot(packageRoot, entry, bytes, metadata) {
  return metadata.name === "tree-sitter" && metadata.version === "0.22.4" &&
    entry === join(packageRoot, "index.js") && createHash("sha256").update(bytes).digest("hex") === treeSitterRootSha256;
}

function assertGrammarEntry(packageRoot, entry, source) {
  const header = /^const root = require\(['"]path['"]\)\.join\(__dirname, ['"]\.\.['"], ['"]\.\.['"]\);\n/;
  const direct = /^module\.exports = require\(['"]node-gyp-build['"]\)\(root\);\n/;
  const bun = /^module\.exports =\n\x20{2}typeof process\.versions\.bun === "string"\n(?:\x20{4}\/\/[^\n]*\n)*\x20{4}\? require\(`\.\.\/\.\.\/prebuilds\/\$\{process\.platform\}-\$\{process\.arch\}\/[^`]+\.node`\)\n\x20{4}: require\("node-gyp-build"\)\(root\);\n/;
  const body = source.replace(header, "").replace(/^\n/, "");
  if (!header.test(source) || dirname(entry) !== join(packageRoot, "bindings", "node")) throw new Error("Unreviewed native grammar root");
  if ([...source.matchAll(/\broot\s*=(?!=)/g)].length !== 1) throw new Error("Native grammar changes its reviewed root");
  if (!direct.test(body) && !bun.test(body)) throw new Error("Unreviewed native grammar entry");
}

function assertLoader(root, entry) {
  const resolved = createRequire(entry).resolve("node-gyp-build");
  const directory = dirname(resolved);
  const metadata = packageMetadata(root, join(directory, "package.json"));
  if (metadata.name !== "node-gyp-build" || metadata.version !== loaderVersion || resolved !== join(directory, "index.js")) throw new Error("Unreviewed node-gyp-build version or entry");
  if (readSource(root, resolved).toString("utf8") !== indexWrapper) throw new Error("Unreviewed node-gyp-build wrapper");
  const source = readSource(root, join(directory, "node-gyp-build.js"));
  if (createHash("sha256").update(source).digest("hex") !== loaderSha256) throw new Error("node-gyp-build loader requires source review");
}

function tuplePlans(state, directory) {
  assertEntry(state.root, directory, "directory");
  const result = { retained: [], removed: [], paths: [] };
  const names = readdirSync(directory).sort();
  if (names.length > 64) throw new Error("Native prebuilds exceed tuple bound");
  for (const name of names) {
    const tuple = checkedTuple(name);
    const path = join(directory, name);
    assertTupleFiles(state.root, path);
    const selected = tuple.platform === state.target.platform && tuple.architectures.includes(state.target.arch);
    result[selected ? "retained" : "removed"].push(name);
    if (!selected) result.paths.push(path);
  }
  return result;
}

function checkedTuple(name) {
  if (!/^(darwin|linux|win32)-(x64|arm64)(?:\+(?:x64|arm64))*$/.test(name)) throw new Error(`Malformed or unreviewed prebuild tuple: ${name}`);
  const [platform, arch] = name.split("-");
  const architectures = arch.split("+");
  if (new Set(architectures).size !== architectures.length) throw new Error("Duplicate prebuild tuple architecture");
  return { platform, architectures };
}

function assertTupleFiles(root, directory) {
  assertEntry(root, directory, "directory");
  const files = readdirSync(directory);
  if (files.length > 1_024) throw new Error("Native prebuild tuple exceeds file bound");
  for (const name of files) assertEntry(root, join(directory, name), "file");
}

function hasCompiledBinding(root, path) {
  for (const directory of [join(path, "build", "Release"), join(path, "build", "Debug")]) {
    if (!existsSync(directory)) continue;
    assertEntry(root, directory, "directory");
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".node")) continue;
      assertEntry(root, join(directory, name), "file");
      return true;
    }
  }
  return false;
}

export function graftParserSmokeSource() {
  return `const { createRequire } = require('node:module');
const { join } = require('node:path');
const graft = createRequire(join(process.argv[1], 'node_modules', '@nanonets', 'graft', 'package.json'));
const Parser = graft('tree-sitter');
const typescript = graft('tree-sitter-typescript').typescript;
const javascript = graft('tree-sitter-javascript');
for (const [name, language, text] of [['typescript', typescript, 'const value: number = 1;'], ['javascript', javascript, 'const value = 1;']]) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  if (!tree || tree.rootNode.hasError || tree.rootNode.type !== 'program') throw new Error('Graft native parser smoke refused ' + name);
}
console.log('Graft native parser smoke passed: typescript, javascript');
`;
}
