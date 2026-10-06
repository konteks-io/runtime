import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as nodePath from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { gunzipSync } from "node:zlib";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const helper = join(scriptDirectory, "offline-graft-prebuilds.mjs");
// Before the repair, execute the existing builder rather than fail to import
// a proposed module. Afterward this binds the real production helper exports.
const helperExports = existsSync(helper) ? await import(pathToFileURL(helper).href) : {};
const coordinates = [
  { platform: "darwin", architecture: "amd64", nodeArch: "x64" },
  { platform: "darwin", architecture: "arm64", nodeArch: "arm64" },
  { platform: "linux", architecture: "amd64", nodeArch: "x64" },
  { platform: "linux", architecture: "arm64", nodeArch: "arm64" },
  { platform: "win32", architecture: "amd64", nodeArch: "x64" },
];
const tuples = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];
const loaderSource = readFileSync(join(scriptDirectory, "fixtures", "node-gyp-build-4.8.4", "node-gyp-build.js"));
const loaderWrapper = `const runtimeRequire = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require // eslint-disable-line
if (typeof runtimeRequire.addon === 'function') { // if the platform supports native resolving prefer that
  module.exports = runtimeRequire.addon.bind(runtimeRequire)
} else { // else use the runtime version here
  module.exports = require('./node-gyp-build.js')
}
`;
const parserPath = "node_modules/@nanonets/graft/node_modules/tree-sitter";

function write(root, path, content) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function seedGraft(root) {
  const packageRoot = parserPath;
  write(root, "node_modules/@nanonets/graft/dist/cli.js", "// controlled CLI fixture\n");
  write(root, "node_modules/@nanonets/graft/package.json", JSON.stringify({ name: "@nanonets/graft", version: "0.18.0", dependencies: { "tree-sitter": "^0.21.1" } }));
  write(root, `${packageRoot}/package.json`, JSON.stringify({ name: "tree-sitter", version: "0.21.1", main: "index.js", dependencies: { "node-gyp-build": "^4.8.0" } }));
  write(root, `${packageRoot}/index.js`, "const binding = require('node-gyp-build')(__dirname);\nmodule.exports = binding.Parser;\n");
  write(root, "node_modules/node-gyp-build/package.json", JSON.stringify({ name: "node-gyp-build", version: "4.8.4", main: "index.js" }));
  write(root, "node_modules/node-gyp-build/index.js", loaderWrapper);
  write(root, "node_modules/node-gyp-build/node-gyp-build.js", loaderSource);
  for (const tuple of tuples) write(root, `${packageRoot}/prebuilds/${tuple}/tree-sitter.node`, `unaltered ${tuple}\n`);
  write(root, `${packageRoot}/build/Release/tree-sitter.node`, "unaltered compiled binding\n");
}

function inventory(root) {
  const parser = join(root, "node_modules", "@nanonets", "graft", "node_modules", "tree-sitter");
  const prebuilds = join(parser, "prebuilds");
  return {
    tuples: readdirSync(prebuilds).sort(),
    contents: Object.fromEntries(readdirSync(prebuilds).sort().map(name => [name, readFileSync(join(prebuilds, name, "tree-sitter.node"), "utf8")])),
    compiled: readFileSync(join(parser, "build", "Release", "tree-sitter.node"), "utf8"),
  };
}

function execBoundary(state, command, args) {
  if (command === "npm" || command === "npm.cmd") {
    state.root = args[args.indexOf("--prefix") + 1];
    seedGraft(state.root);
    if (state.developmentCli) seedDevelopmentCli(state.root);
    state.before = inventory(state.root);
    return;
  }
  state.calls.push({ command, args: [...args] });
  if (command === "tar") { state.archived = inventory(state.root); state.cliArchived = existsSync(join(state.root, "node_modules/tree-sitter-cli/tree-sitter")); }
}

function builderContext(directory, coordinate, state) {
  const work = join(directory, "work");
  mkdirSync(work);
  const config = join(directory, "build-config.json");
  writeFileSync(config, JSON.stringify({ nodeVersion: process.versions.node, tools: { graft: { package: "@nanonets/graft", version: "0.18.0", entrypoint: "dist/cli.js" } } }));
  return {
    ...helperExports, existsSync, mkdirSync, readFileSync, rmSync, tmpdir, join,
    // Existing prebuild-only fixtures do not model the separate reviewed CLI graph.
    pruneGraftDevelopmentCli: state.developmentCli ? helperExports.pruneGraftDevelopmentCli : () => [],
    mkdtempSync: () => work,
    execFileSync: (command, args) => execBoundary(state, command, args),
    process: { platform: coordinate.platform, arch: coordinate.nodeArch, version: process.version, execPath: process.execPath, env: {}, argv: [process.execPath, "builder", "--tool", "graft", "--architecture", coordinate.architecture, "--config", config, "--out", join(directory, "fixture.tgz")] },
    macOsArtifactOptions: architecture => ({ architecture, minimumOS: "13" }),
    assertMacOsArtifactTree: root => { state.guard = inventory(root); state.cliAtGuard = existsSync(join(root, "node_modules/tree-sitter-cli/tree-sitter")); state.calls.push({ command: "compatibility", args: [] }); },
    console: { log: () => {} },
  };
}

function buildFixture(coordinate, developmentCli = false) {
  const directory = mkdtempSync(join(tmpdir(), "graft-builder-characterization-"));
  const state = { calls: [], developmentCli };
  try {
    const source = readFileSync(join(scriptDirectory, "build-offline-tool.mjs"), "utf8").replace(/^import .+;\r?$/gm, "");
    runInNewContext(source, builderContext(directory, coordinate, state), { timeout: 5_000 });
    return state;
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const coordinate of coordinates) {
  test(`Graft builder preserves selected bindings on ${coordinate.platform}/${coordinate.nodeArch}`, () => {
    const state = buildFixture(coordinate);
    if (coordinate.platform !== "darwin") {
      assert.deepEqual(state.archived, state.before, "initial repair must leave non-Mac package bytes untouched");
      return;
    }
    const tuple = `darwin-${coordinate.nodeArch}`;
    assert.deepEqual(state.guard.tuples, [tuple], "foreign tuple reached the complete Mac compatibility guard");
    assert.deepEqual(state.archived, state.guard);
    assert.equal(state.archived.contents[tuple], state.before.contents[tuple]);
    assert.equal(state.archived.compiled, state.before.compiled);
  });
}

for (const coordinate of coordinates.filter(value => value.platform === "darwin")) {
  test(`Graft builder loads real parser bindings before archiving ${coordinate.nodeArch}`, () => {
    const state = buildFixture(coordinate);
    const smoke = state.calls.findIndex(call => call.command === process.execPath && call.args.some(value => typeof value === "string" && value.includes(".parse(")));
    const guard = state.calls.findIndex(call => call.command === "compatibility");
    const archive = state.calls.findIndex(call => call.command === "tar");
    assert.ok(smoke >= 0, "--version alone never exercises a parser binding");
    assert.ok(smoke < guard && guard < archive, "real parser smoke and complete metadata gate must precede publication bytes");
  });
}

function parserFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "graft-prebuild-selector-"));
  try {
    seedGraft(root);
    return run(root);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
}

function reviewedLoader(coordinate, root, prebuildsOnly) {
  const module = { exports: {} };
  const scope = {
    module,
    process: { config: {}, env: { LIBC: "glibc", PREBUILDS_ONLY: prebuildsOnly ? "1" : "" }, versions: process.versions, execPath: process.execPath },
    require: name => loaderDependency(name, coordinate, root),
  };
  runInNewContext(loaderSource.toString("utf8"), scope, { timeout: 1_000 });
  return module.exports;
}

function loaderDependency(name, coordinate, root) {
  if (name === "fs") return fixtureFileSystem(root);
  if (name === "path") return nodePath;
  if (name === "os") return { arch: () => coordinate.nodeArch, platform: () => coordinate.platform };
  assert.ok(resolve(name).startsWith(`${resolve(root)}${nodePath.sep}`), "reviewed loader may only read fixture metadata");
  assert.ok(name.endsWith("package.json"));
  return JSON.parse(readFileSync(name, "utf8"));
}

function fixtureFileSystem(root) {
  return {
    readdirSync: path => { assert.ok(resolve(path).startsWith(`${resolve(root)}${nodePath.sep}`)); return readdirSync(path); },
    existsSync: path => { assert.ok(resolve(path).startsWith(`${resolve(root)}${nodePath.sep}`)); return existsSync(path); },
  };
}

function authenticatedFixtureCheckout(name, fixture = "node-gyp-build-4.8.4") {
  const directory = mkdtempSync(join(tmpdir(), "graft-authenticated-checkout-"));
  try {
    const source = join(directory, "source");
    const checkout = join(directory, "checkout");
    mkdirSync(source);
    mkdirSync(checkout);
    const config = join(directory, "empty-git-config");
    writeFileSync(config, "", { flag: "wx" });
    const options = { cwd: source, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config, GIT_ATTR_NOSYSTEM: "1" }, timeout: 15_000, windowsHide: true, stdio: "pipe" };
    const file = `scripts/fixtures/${fixture}/${name}`;
    write(source, file, readFileSync(join(scriptDirectory, "fixtures", fixture, name)));
    const attributes = join(dirname(scriptDirectory), ".gitattributes");
    if (existsSync(attributes)) write(source, ".gitattributes", readFileSync(attributes));
    execFileSync("git", ["init", "--quiet"], options);
    execFileSync("git", ["-c", "core.autocrlf=false", "add", "--", "."], options);
    execFileSync("git", ["-c", "core.autocrlf=true", "checkout-index", "--all", `--prefix=${checkout}${nodePath.sep}`], options);
    return readFileSync(join(checkout, file));
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const name of ["node-gyp-build.js", "LICENSE"]) {
  test(`Graft authenticated fixture checkout preserves exact ${name} bytes with autocrlf`, () => {
    const expected = readFileSync(join(scriptDirectory, "fixtures", "node-gyp-build-4.8.4", name));
    assert.deepEqual(authenticatedFixtureCheckout(name), expected);
  });
}

test("Graft selector fixture is the independently verified node-gyp-build4.8.4 source", () => {
  assert.equal(loaderSource.length, 6_078);
  assert.equal(createHash("sha256").update(loaderSource).digest("hex"), "134f0585f7c665db89f332a379158c6f113274422e42aaf54e0aa9d5ac37f577");
  assert.match(readFileSync(join(scriptDirectory, "fixtures", "node-gyp-build-4.8.4", "LICENSE"), "utf8"), /Copyright \(c\) 2017 Mathias Buus/);
});

for (const coordinate of coordinates) {
  test(`Graft tuples preserve the actual reviewed loader choice on ${coordinate.platform}/${coordinate.nodeArch}`, () => parserFixture(root => {
    const parser = join(root, parserPath);
    const loader = reviewedLoader(coordinate, root, true);
    const selected = loader.resolve(parser);
    const original = readFileSync(selected);
    const compiled = reviewedLoader(coordinate, root, false).resolve(parser);
    const provenance = helperExports.pruneGraftPrebuilds(root, coordinate);
    assert.equal(loader.resolve(parser), selected);
    assert.deepEqual(readFileSync(selected), original);
    assert.equal(reviewedLoader(coordinate, root, false).resolve(parser), compiled);
    assert.equal(provenance[0].loaderVersion, "4.8.4");
    assert.deepEqual(provenance[0].retained, [`${coordinate.platform}-${coordinate.nodeArch}`]);
  }));
}

test("Graft preserves multi-architecture tuples the reviewed loader may select", () => parserFixture(root => {
  const coordinate = coordinates[0];
  const tuple = `${parserPath}/prebuilds/darwin-x64+arm64/tree-sitter.node`;
  write(root, tuple, "unchanged multi-architecture candidate\n");
  const selected = reviewedLoader(coordinate, root, true).resolve(join(root, parserPath));
  const [provenance] = helperExports.pruneGraftPrebuilds(root, coordinate);
  assert.deepEqual(provenance.retained, ["darwin-x64", "darwin-x64+arm64"]);
  assert.equal(readFileSync(join(root, tuple), "utf8"), "unchanged multi-architecture candidate\n");
  assert.equal(reviewedLoader(coordinate, root, true).resolve(join(root, parserPath)), selected);
}));

const refusals = [
  ["changed loader bytes", root => write(root, "node_modules/node-gyp-build/node-gyp-build.js", `${loaderSource}\n// changed\n`), /source review/],
  ["changed loader wrapper", root => write(root, "node_modules/node-gyp-build/index.js", "module.exports = require('./other.js');\n"), /wrapper/],
  ["unknown loader version", root => write(root, "node_modules/node-gyp-build/package.json", JSON.stringify({ name: "node-gyp-build", version: "4.8.5", main: "index.js" })), /version or entry/],
  ["unknown consumer syntax", root => write(root, `${parserPath}/index.js`, "module.exports = require('node-gyp-build')(somewhere);\n"), /argument/],
  ["shadowed loader context", root => write(root, `${parserPath}/index.js`, "const binding = require('node-gyp-build')(__dirname);\nfunction require() {}\n"), /shadows/],
  ["malformed tuple", root => write(root, `${parserPath}/prebuilds/darwin-x64-musl/tree-sitter.node`, "unknown\n"), /tuple/],
  ["duplicate tuple architecture", root => write(root, `${parserPath}/prebuilds/darwin-x64+x64/tree-sitter.node`, "unknown\n"), /Duplicate/],
];

for (const [name, mutate, expected] of refusals) {
  test(`Graft refuses ${name} before any tuple removal`, () => parserFixture(root => {
    mutate(root);
    const before = inventory(root);
    assert.throws(() => helperExports.pruneGraftPrebuilds(root, coordinates[0]), expected);
    assert.deepEqual(inventory(root), before);
  }));
}

test("Graft refuses a linked tuple without deleting its target or earlier tuples", () => parserFixture(root => {
  const target = join(root, "linked-target");
  mkdirSync(target);
  writeFileSync(join(target, "tree-sitter.node"), "unrelated fixture bytes\n");
  symlinkSync(target, join(root, parserPath, "prebuilds", "darwin-x64+arm64"), "junction");
  assert.throws(() => helperExports.pruneGraftPrebuilds(root, coordinates[0]), /link/);
  assert.equal(readFileSync(join(target, "tree-sitter.node"), "utf8"), "unrelated fixture bytes\n");
  assert.ok(existsSync(join(root, parserPath, "prebuilds", "darwin-arm64", "tree-sitter.node")));
}));

test("Graft plans every native consumer before deleting any foreign tuple", () => parserFixture(root => {
  const foreign = join(root, parserPath, "prebuilds", "darwin-arm64", "tree-sitter.node");
  write(root, "node_modules/z-unreviewed/package.json", JSON.stringify({ name: "z-unreviewed", version: "1.0.0", main: "index.js" }));
  write(root, "node_modules/z-unreviewed/index.js", "module.exports = {};\n");
  write(root, "node_modules/z-unreviewed/prebuilds/darwin-arm64/binding.node", "unknown consumer\n");
  assert.throws(() => helperExports.pruneGraftPrebuilds(root, coordinates[0]), /Unreviewed native loader consumer/);
  assert.equal(readFileSync(foreign, "utf8"), "unaltered darwin-arm64\n");
}));

function seedGrammar(root, name, bun = false) {
  const path = `node_modules/@nanonets/graft/node_modules/${name}`;
  const call = bun ? [
    "module.exports =",
    '  typeof process.versions.bun === "string"',
    "    // Support the same upstream Bun-only static native path.",
    `    ? require(\`../../prebuilds/\${process.platform}-\${process.arch}/${name}.node\`)`,
    '    : require("node-gyp-build")(root);',
  ].join("\n") : 'module.exports = require("node-gyp-build")(root);';
  write(root, `${path}/package.json`, JSON.stringify({ name, version: "0.23.2", main: "bindings/node", dependencies: { "node-gyp-build": "^4.8.0" } }));
  write(root, `${path}/bindings/node/index.js`, `const root = require("path").join(__dirname, "..", "..");\n\n${call}\n`);
  for (const tuple of tuples) write(root, `${path}/prebuilds/${tuple}/${name}.node`, `unchanged ${name} ${tuple}\n`);
  return path;
}

for (const bun of [false, true]) {
  test(`Graft recognizes literal grammar roots${bun ? " with the reviewed Bun branch" : ""}`, () => parserFixture(root => {
    const path = seedGrammar(root, "tree-sitter-typescript", bun);
    const original = readFileSync(join(root, path, "prebuilds", "darwin-x64", "tree-sitter-typescript.node"));
    const records = helperExports.pruneGraftPrebuilds(root, coordinates[0]);
    assert.equal(records.length, 2);
    assert.deepEqual(records.find(value => value.package === "tree-sitter-typescript").retained, ["darwin-x64"]);
    assert.deepEqual(readFileSync(join(root, path, "prebuilds", "darwin-x64", "tree-sitter-typescript.node")), original);
  }));
}

test("Graft refuses a consumer whose __dirname is not its package prebuild root", () => parserFixture(root => {
  write(root, `${parserPath}/package.json`, JSON.stringify({ name: "tree-sitter", version: "0.21.1", main: "different/index.js", dependencies: { "node-gyp-build": "^4.8.0" } }));
  write(root, `${parserPath}/different/index.js`, "const binding = require('node-gyp-build')(__dirname);\nmodule.exports = binding.Parser;\n");
  const before = inventory(root);
  assert.throws(() => helperExports.pruneGraftPrebuilds(root, coordinates[0]), /root entry/);
  assert.deepEqual(inventory(root), before);
}));

test("Graft refuses a grammar whose root expression is not the reviewed literal mapping", () => parserFixture(root => {
  const path = seedGrammar(root, "tree-sitter-typescript");
  write(root, `${path}/bindings/node/index.js`, 'const root = require("path").join(__dirname, "..", "somewhere");\nmodule.exports = require("node-gyp-build")(root);\n');
  const before = inventory(root);
  assert.throws(() => helperExports.pruneGraftPrebuilds(root, coordinates[0]), /grammar root/);
  assert.deepEqual(inventory(root), before);
}));

test("Graft parser smoke resolves all languages through its own package and refuses parse errors", () => {
  const parsed = [];
  const languages = new Map([["typescript", {}], ["javascript", {}], ["swift", {}]]);
  const parser = smokeParser(parsed, languages);
  const exports = new Map([["tree-sitter", parser], ["tree-sitter-typescript", { typescript: languages.get("typescript") }], ["tree-sitter-javascript", languages.get("javascript")], ["tree-sitter-swift", languages.get("swift")]]);
  const root = join(tmpdir(), "owned-graft-smoke");
  const expected = join(root, "node_modules", "@nanonets", "graft", "package.json");
  const context = { process: { argv: [process.execPath, root] }, console: { log: () => {} }, require: name => smokeDependency(name, exports, expected) };
  runInNewContext(helperExports.graftParserSmokeSource(), context, { timeout: 1_000 });
  assert.deepEqual(parsed.map(value => value.language), ["typescript", "javascript", "swift"]);
  exports.set("tree-sitter", class { setLanguage() {} parse() { return { rootNode: { hasError: true, type: "program" } }; } });
  assert.throws(() => runInNewContext(helperExports.graftParserSmokeSource(), { ...context }, { timeout: 1_000 }), /smoke refused/);
});

function smokeParser(parsed, languages) {
  return class {
    setLanguage(language) { this.language = [...languages].find(([, value]) => value === language)[0]; }
    parse(text) { parsed.push({ language: this.language, text }); return { rootNode: { hasError: false, type: this.language === "swift" ? "source_file" : "program" } }; }
  };
}

function smokeDependency(name, exports, expected) {
  if (name === "node:path") return { join };
  assert.equal(name, "node:module");
  return { createRequire: entry => {
    assert.equal(entry, expected);
    return name => { assert.ok(exports.has(name)); return exports.get(name); };
  } };
}

const cliFixtureDirectory = join(scriptDirectory, "fixtures", "graft-0.18.0-cli-consumers");
const cliFixtureBytes = readFileSync(join(cliFixtureDirectory, "sources.json.gz"));
assert.equal(createHash("sha256").update(cliFixtureBytes).digest("hex"), "1c9a972090437b75ac065d3e568e736c588dcec5ed8484216bebba2e8c7c62d7");
const cliSources = JSON.parse(gunzipSync(cliFixtureBytes, { maxOutputLength: 2 * 1024 * 1024 }).toString("utf8")).sources;

function seedDevelopmentCli(root) {
  for (const row of cliSources) write(root, `node_modules/${row.package}/${row.path}`, Buffer.from(row.base64, "base64"));
  write(root, "node_modules/tree-sitter-cli/tree-sitter", "controlled unused native CLI fixture\n");
  write(root, "node_modules/.bin/tree-sitter", "controlled untouched launcher fixture\n");
}

for (const coordinate of coordinates) {
  test(`Graft developmental CLI builder only prunes on ${coordinate.platform}/${coordinate.nodeArch}`, () => {
    const state = buildFixture(coordinate, true);
    assert.equal(state.cliArchived, coordinate.platform !== "darwin");
    if (coordinate.platform === "darwin") assert.equal(state.cliAtGuard, false, "development-only downloaded CLI must be removed before complete Mach-O inspection");
  });
}

test("Graft developmental CLI parser smoke actually exercises Swift without a CLI process", () => {
  const parsed = [];
  const languages = new Map([["typescript", {}], ["javascript", {}], ["swift", {}]]);
  const exports = new Map([["tree-sitter", smokeParser(parsed, languages)], ["tree-sitter-typescript", { typescript: languages.get("typescript") }], ["tree-sitter-javascript", languages.get("javascript")], ["tree-sitter-swift", languages.get("swift")]]);
  const root = join(tmpdir(), "graft-cli-parser-smoke");
  const expected = join(root, "node_modules", "@nanonets", "graft", "package.json");
  runInNewContext(helperExports.graftParserSmokeSource(), { require: name => smokeDependency(name, exports, expected), process: { argv: ["node", root] }, console: { log() {} } }, { timeout: 1_000 });
  assert.deepEqual(parsed.map(value => value.language), ["typescript", "javascript", "swift"]);
});

for (const coordinate of coordinates) {
  test(`Graft developmental CLI exact source preserves runtime and launcher bytes on ${coordinate.platform}/${coordinate.nodeArch}`, () => parserFixture(root => {
    seedDevelopmentCli(root);
    const rows = helperExports.pruneGraftDevelopmentCli(root, coordinate);
    assert.equal(existsSync(join(root, "node_modules/tree-sitter-cli/tree-sitter")), coordinate.platform !== "darwin");
    assert.equal(rows.length, coordinate.platform === "darwin" ? 1 : 0);
    for (const row of cliSources) assert.deepEqual(readFileSync(join(root, `node_modules/${row.package}/${row.path}`)), Buffer.from(row.base64, "base64"));
    assert.equal(readFileSync(join(root, "node_modules/.bin/tree-sitter"), "utf8"), "controlled untouched launcher fixture\n");
    assert.deepEqual(inventory(root).tuples, tuples.slice().sort(), "CLI removal cannot change native grammar selection");
  }));
}

const developmentCliRefusals = [
  ["unreviewed Graft identity", root => appendCliSource(root, "@nanonets/graft/package.json"), /source review/],
  ["changed runtime process consumer", root => appendCliSource(root, "@nanonets/graft/dist/cli.js"), /closure.*source review/],
  ["new runtime source", root => write(root, "node_modules/@nanonets/graft/dist/extra.js", "import 'tree-sitter-cli';\n"), /closure.*source review/],
  ["unreviewed Swift version", root => appendCliSource(root, "tree-sitter-swift/package.json"), /source review/],
  ["changed Swift binding", root => appendCliSource(root, "tree-sitter-swift/bindings/node/index.js"), /source review/],
  ["different installed CLI version", root => write(root, "node_modules/tree-sitter-cli/package.json", JSON.stringify({ name: "tree-sitter-cli", version: "0.23.1" })), /source review/],
  ["changed CLI entry", root => appendCliSource(root, "tree-sitter-cli/cli.js"), /source review/],
  ["changed CLI installer", root => appendCliSource(root, "tree-sitter-cli/install.js"), /source review/],
  ["hardlinked CLI native file", root => linkSync(join(root, "node_modules/tree-sitter-cli/tree-sitter"), join(root, "shared-native")), /bounded regular/],
  ["directory instead of native file", root => { rmSync(join(root, "node_modules/tree-sitter-cli/tree-sitter")); mkdirSync(join(root, "node_modules/tree-sitter-cli/tree-sitter")); }, /regular file/],
  ["linked CLI package", root => linkedDevelopmentPackage(root), /link/],
];

function appendCliSource(root, name) {
  const path = `node_modules/${name}`;
  write(root, path, Buffer.concat([readFileSync(join(root, path)), Buffer.from("\n ")]));
}

function linkedDevelopmentPackage(root) {
  const original = join(root, "node_modules/tree-sitter-cli");
  const moved = join(root, "held-cli");
  mkdirSync(moved);
  for (const name of readdirSync(original)) writeFileSync(join(moved, name), readFileSync(join(original, name)));
  rmSync(original, { recursive: true });
  symlinkSync(moved, original, process.platform === "win32" ? "junction" : "dir");
}

for (const [name, mutate, expected] of developmentCliRefusals) {
  test(`Graft developmental CLI refuses ${name} before native-file removal`, () => parserFixture(root => {
    seedDevelopmentCli(root);
    mutate(root);
    const before = inventory(root);
    assert.throws(() => helperExports.pruneGraftDevelopmentCli(root, coordinates[0]), expected);
    assert.ok(existsSync(join(root, "node_modules/tree-sitter-cli/tree-sitter")));
    assert.deepEqual(inventory(root), before);
  }));
}

const reviewedRootDirectory = join(scriptDirectory, "fixtures", "tree-sitter-0.22.4");
const reviewedRootSource = readFileSync(join(reviewedRootDirectory, "index.js"));
const reviewedRootManifest = readFileSync(join(reviewedRootDirectory, "package.json"));

function seedReviewedRoot(root) {
  write(root, `${parserPath}/package.json`, reviewedRootManifest);
  write(root, `${parserPath}/index.js`, reviewedRootSource);
}

test("Graft reviewed tree-sitter 0.22.4 fixture has the authenticated raw source and package identity", () => {
  assert.equal(reviewedRootSource.length, 26_448);
  assert.equal(createHash("sha256").update(reviewedRootSource).digest("hex"), "830fa91de08c3c8348e7f8614ec41b20147f7f4a7491ed944d4a68e15ce89716");
  assert.equal(createHash("sha256").update(reviewedRootManifest).digest("hex"), "ae7daa24f7b4bc68d2f57b0c017ffbb127dac1ec3b8d3d827bbb194b87821984");
  assert.equal(JSON.parse(reviewedRootManifest.toString("utf8")).license, "MIT");
  const license = readFileSync(join(reviewedRootDirectory, "LICENSE"));
  assert.equal(createHash("sha256").update(license).digest("hex"), "d39420a108609f487bece31800015cccabdb531fee4d543d66595459b3812d9a");
  assert.match(license.toString("utf8"), /Copyright \(c\) 2014 maxbrunsfeld/);
});

for (const name of ["index.js", "package.json", "LICENSE"]) {
  test(`Graft reviewed tree-sitter 0.22.4 checkout preserves authenticated ${name} bytes`, () => {
    assert.deepEqual(authenticatedFixtureCheckout(name, "tree-sitter-0.22.4"), readFileSync(join(reviewedRootDirectory, name)));
  });
}

for (const coordinate of coordinates) {
  test(`Graft reviewed tree-sitter 0.22.4 preserves the actual loader choice on ${coordinate.platform}/${coordinate.nodeArch}`, () => parserFixture(root => {
    seedReviewedRoot(root);
    const parser = join(root, parserPath);
    const selected = reviewedLoader(coordinate, root, true).resolve(parser);
    const selectedBytes = readFileSync(selected);
    const compiled = reviewedLoader(coordinate, root, false).resolve(parser);
    const compiledBytes = readFileSync(compiled);
    const [provenance] = helperExports.pruneGraftPrebuilds(root, coordinate);
    assert.equal(reviewedLoader(coordinate, root, true).resolve(parser), selected);
    assert.deepEqual(readFileSync(selected), selectedBytes);
    assert.equal(reviewedLoader(coordinate, root, false).resolve(parser), compiled);
    assert.deepEqual(readFileSync(compiled), compiledBytes);
    assert.deepEqual(provenance.retained, [`${coordinate.platform}-${coordinate.nodeArch}`]);
    assert.equal(provenance.version, "0.22.4");
    assert.equal(provenance.loaderVersion, "4.8.4");
  }));
}

const reviewedRootRefusals = [
  ["different identity", root => editReviewedManifest(root, { name: "not-tree-sitter" }), /root entry/],
  ["different version", root => editReviewedManifest(root, { version: "0.22.5" }), /root entry/],
  ["changed source bytes", root => write(root, `${parserPath}/index.js`, Buffer.concat([reviewedRootSource, Buffer.from("\n// changed\n")])), /root entry/],
  ["normalized instead of raw source", root => write(root, `${parserPath}/index.js`, reviewedRootSource.toString("utf8").replaceAll("\n", "\r\n")), /root entry/],
  ["different physical entry", root => { editReviewedManifest(root, { main: "different.js" }); write(root, `${parserPath}/different.js`, reviewedRootSource); }, /root entry/],
  ["extra loader call", root => write(root, `${parserPath}/index.js`, Buffer.concat([reviewedRootSource, Buffer.from("\nrequire('node-gyp-build')(__dirname);\n")])), /loader call syntax/],
  ["shadowed loader", root => write(root, `${parserPath}/index.js`, Buffer.concat([reviewedRootSource, Buffer.from("\nfunction require() {}\n")])), /shadows/],
  ["tampered pinned loader", root => write(root, "node_modules/node-gyp-build/node-gyp-build.js", Buffer.concat([loaderSource, Buffer.from("\n// changed\n")])), /source review/],
];

function editReviewedManifest(root, change) {
  const manifest = JSON.parse(reviewedRootManifest.toString("utf8"));
  write(root, `${parserPath}/package.json`, JSON.stringify({ ...manifest, ...change }));
}

for (const [name, mutate, expected] of reviewedRootRefusals) {
  test(`Graft reviewed tree-sitter 0.22.4 refuses ${name} before removal`, () => parserFixture(root => {
    seedReviewedRoot(root);
    mutate(root);
    const before = inventory(root);
    assert.throws(() => helperExports.pruneGraftPrebuilds(root, coordinates[0]), expected);
    assert.deepEqual(inventory(root), before);
  }));
}

test("Graft reviewed tree-sitter 0.22.4 refusal includes bounded consumer context and the original cause", () => parserFixture(root => {
  seedReviewedRoot(root);
  write(root, `${parserPath}/index.js`, Buffer.concat([reviewedRootSource, Buffer.from("\n// changed\n")]));
  const before = inventory(root);
  assert.throws(() => helperExports.pruneGraftPrebuilds(root, coordinates[0]), error => {
    assert.match(error.message, /tree-sitter@0\.22\.4/);
    assert.ok(error.message.includes(JSON.stringify(`${parserPath}/index.js`)));
    assert.ok(!error.message.includes(root));
    assert.ok(error.cause instanceof Error);
    assert.match(error.cause.message, /Unreviewed native root entry/);
    return true;
  });
  assert.deepEqual(inventory(root), before);
  assertBoundedConsumerContext();
}));

function assertBoundedConsumerContext() {
  const source = readFileSync(helper, "utf8").match(/function consumerEntryContext\(root, entry\) \{[^]*?\n\}/)?.[0];
  assert.ok(source, "production rejection context must have an explicit byte bound");
  const context = scoped => runInNewContext(`${source}\nconsumerEntryContext('root', 'entry');`, { scopedRelative: () => scoped, sep: "/", Buffer }, { timeout: 1_000 });
  assert.equal(context("x".repeat(4_096)), "x".repeat(4_096));
  assert.equal(context("x".repeat(4_097)), "<staging-relative entry omitted: exceeds 4096 UTF-8 bytes>");
  assert.equal(context("é".repeat(2_049)), "<staging-relative entry omitted: exceeds 4096 UTF-8 bytes>");
}

test("Graft reviewed tree-sitter 0.22.4 actual source uses the package-root Node22 loader branch", () => {
  assert.match(process.versions.node, /^22\./);
  const module = { exports: {} };
  const root = join(tmpdir(), "owned-tree-sitter-root");
  const calls = [];
  const binding = stubTreeSitterBinding();
  const require = name => {
    calls.push(name);
    if (name === "util") return { inspect: { custom: Symbol.for("nodejs.util.inspect.custom") } };
    assert.equal(name, "node-gyp-build", "Node22 must not load the Bun-only native path");
    return directory => { assert.equal(directory, root); return binding; };
  };
  runInNewContext(reviewedRootSource.toString("utf8"), { module, require, __dirname: root, process: { versions: process.versions } }, { timeout: 1_000 });
  assert.deepEqual(calls, ["node-gyp-build", "util"]);
  assert.equal(module.exports, binding.Parser);
});

function stubTreeSitterBinding() {
  return { Query: class {}, Parser: class {}, Tree: class {}, TreeCursor: class {}, LookaheadIterator: class {}, NodeMethods: {}, pointTransferArray: [] };
}
