import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
const hash = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function offlineFixture(os = "macos", architecture = "arm64", agentId: "claude-code" | "codex" = "codex") {
  const suffix = os === "windows" ? ".exe" : "";
  const family = {
    "claude-code": { bridgePackage: "@agentclientprotocol/claude-agent-acp", bridgeVersion: "0.75.1", toolingPackage: "@anthropic-ai/claude-code", tooling: `bin/claude${suffix}` },
    codex: { bridgePackage: "@agentclientprotocol/codex-acp", bridgeVersion: "1.10.0", toolingPackage: "@openai/codex", tooling: `bin/codex${suffix}` },
  }[agentId];
  const files = [
    { path: family.tooling, bytes: Buffer.from(`official-${agentId}-not-executed`), executable: true },
    { path: `bin/node${suffix}`, bytes: Buffer.from("node-runtime-not-executed"), executable: true },
    { path: "bridge/index.js", bytes: Buffer.from("// ACP bridge with offline dependencies"), executable: false },
    { path: "bridge/node_modules/example/package.json", bytes: Buffer.from('{"name":"example"}'), executable: false },
  ];
  const profile = {
    schemaVersion: 1, agentId, os, architecture,
    bridge: { package: family.bridgePackage, version: family.bridgeVersion, entrypoint: "bridge/index.js", runtime: "node" },
    tooling: { package: family.toolingPackage, version: "0.153.3", entrypoint: family.tooling, runtime: "native" },
    node: { version: "22.23.2", entrypoint: `bin/node${suffix}` },
    files: files.map(file => ({ path: file.path, digest: hash(file.bytes), sizeBytes: file.bytes.length, executable: file.executable })),
  };
  const receipt = Buffer.from(JSON.stringify(profile));
  const entries = [{ path: "konteks-agent.json", bytes: receipt }, ...files];
  const archive = gzipSync(tar(entries));
  const artifact = { id: `${agentId}-offline`, kind: "agent_bridge", format: "offline_agent_tgz", agentId, os, architecture, url: `https://release.example/${agentId}.tgz`, digest: hash(archive), profileDigest: hash(receipt), sizeBytes: archive.length };
  return { profile, receipt, files, entries, archive, artifact };
}

export function tar(entries: { path: string; bytes: Buffer; type?: string }[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const block = Buffer.alloc(512);
    block.write(entry.path, 0, 100, "utf8");
    block.write("0000600\0", 100); block.write("0000000\0", 108); block.write("0000000\0", 116);
    block.write(`${entry.bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    block.write("00000000000\0", 136); block.fill(32, 148, 156);
    block.write(entry.type ?? "0", 156); block.write("ustar\0", 257); block.write("00", 263);
    block.write(`${block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(block, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
