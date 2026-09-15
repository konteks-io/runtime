#!/usr/bin/env node
/**
 * Release pipeline: detached Ed25519 signature over the SHA256SUMS manifest
 * with the Konteks release key (the same key that signs the release
 * manifest), plus the public key in SubjectPublicKeyInfo PEM so the POSIX
 * bootstrap can verify with `openssl pkeyutl -verify -rawin`.
 */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => (value.startsWith("--") ? [value.slice(2), all[index + 1]] : [])).filter((pair) => pair.length === 2));
const privateKey = createPrivateKey({ key: JSON.parse(readFileSync(args.key, "utf8")), format: "jwk" });
const data = readFileSync(args.in);
writeFileSync(args.out, sign(null, data, privateKey));
writeFileSync(args.pub, createPublicKey(privateKey).export({ type: "spki", format: "pem" }));
console.log(`signed ${args.in} -> ${args.out}; public key at ${args.pub}`);
