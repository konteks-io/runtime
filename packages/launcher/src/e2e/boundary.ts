import { isAbsolute, normalize, sep } from "node:path";

/** The E2E gate is on and the directory is the stack's own `.runtime/native-cloud`. */
export function insideE2EBoundary(gate: string | undefined, directory: string): boolean {
  return gate === "1" && isAbsolute(directory) && normalize(directory).split(sep).slice(-2).join("/") === ".runtime/native-cloud";
}

/** A loopback host, this exact path, and no credentials, query or fragment. */
export function plainLoopbackUrl(value: URL, pathname: string): boolean {
  return value.pathname === pathname && !value.search && !value.hash && !value.username && !value.password && ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname);
}
