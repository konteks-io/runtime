import { homedir } from "node:os";
import { join } from "node:path";

/**
 * OS adapters isolate privilege and paths. The launcher creates ONE
 * restricted root with separate subvolumes for the supervisor, gateway
 * (configuration only — never keys), each agent's credential volume,
 * Harness, Validation, and the browser tool. Elevation is needed only to
 * install the service and create the root.
 */
export type HostOs = "macos" | "windows" | "debian";
export type HostArch = "amd64" | "arm64";

export interface HostPlatform {
  os: HostOs;
  architecture: HostArch;
  containerBackend: "docker_compose";
}

export function detectPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): HostPlatform {
  const architecture: HostArch = arch === "arm64" ? "arm64" : "amd64";
  switch (platform) {
    case "darwin":
      return { os: "macos", architecture, containerBackend: "docker_compose" };
    case "win32":
      return { os: "windows", architecture: "amd64", containerBackend: "docker_compose" };
    case "linux":
      return { os: "debian", architecture, containerBackend: "docker_compose" };
    default:
      throw new Error(`unsupported platform ${platform}`);
  }
}

export interface InstallPaths {
  root: string;
  supervisorData: string;
  gatewayConfig: string;
  credentials: (agentId: string) => string;
  harnessData: string;
  validationData: string;
  browserData: string;
  stores: string;
  composeDir: string;
  composeFile: string;
  envFile: string;
  installState: string;
  releaseManifest: string;
  releaseRoots: string;
  backups: string;
  logs: string;
}

export function defaultInstallRoot(os: HostOs, env: NodeJS.ProcessEnv = process.env): string {
  if (env.KONTEKS_REMOTE_ROOT) return env.KONTEKS_REMOTE_ROOT;
  switch (os) {
    case "macos":
      return join(homedir(), "Library", "Application Support", "konteks-remote");
    case "windows":
      return join(env.ProgramData ?? "C:\\ProgramData", "konteks-remote");
    case "debian":
      return "/var/lib/konteks-remote";
  }
}

export function installPaths(root: string): InstallPaths {
  return {
    root,
    supervisorData: join(root, "supervisor"),
    gatewayConfig: join(root, "gateway"),
    credentials: (agentId) => join(root, "credentials", agentId),
    harnessData: join(root, "harness"),
    validationData: join(root, "validation-runtime"),
    browserData: join(root, "browser-tool"),
    stores: join(root, "stores"),
    composeDir: join(root, "compose"),
    composeFile: join(root, "compose", "compose.yaml"),
    envFile: join(root, "compose", ".env"),
    installState: join(root, "install-state.json"),
    releaseManifest: join(root, "compose", "release-manifest.json"),
    releaseRoots: join(root, "compose", "release-roots.json"),
    backups: join(root, "backups"),
    logs: join(root, "logs"),
  };
}

export const COMPOSE_PROJECT_NAME = "konteks-remote";

/**
 * Every bind-mounted directory the bundle needs, with the fixed non-root uid
 * that owns it inside its container (see the Dockerfiles and the Compose
 * template). On Docker Desktop ownership is mapped by the file-sharing layer;
 * on Debian the launcher `chown`s these once at create time — the only
 * privileged step besides installing the service.
 */
export interface VolumeDirectory {
  path: string;
  uid: number;
  gid: number;
  /** Which service reads it; documentation for `doctor` and the support bundle. */
  owner: string;
}

export const VOLUME_UIDS = Object.freeze({
  supervisor: 10010,
  gateway: 10011,
  sysmon: 10020,
  runner: 10030,
  forwarder: 10040,
  harness: 10060,
  validation: 10061,
  postgres: 70,
  browserTool: 1000,
});

export function volumeDirectories(paths: InstallPaths, agentIds: readonly string[]): VolumeDirectory[] {
  const dirs: VolumeDirectory[] = [
    { path: paths.supervisorData, uid: VOLUME_UIDS.supervisor, gid: VOLUME_UIDS.supervisor, owner: "supervisor" },
    { path: paths.gatewayConfig, uid: VOLUME_UIDS.gateway, gid: VOLUME_UIDS.gateway, owner: "gateway" },
    { path: join(paths.harnessData, "data"), uid: VOLUME_UIDS.harness, gid: VOLUME_UIDS.harness, owner: "harness" },
    { path: join(paths.harnessData, "data", "checkouts"), uid: VOLUME_UIDS.harness, gid: VOLUME_UIDS.harness, owner: "harness" },
    { path: join(paths.harnessData, "data", "workspaces"), uid: VOLUME_UIDS.runner, gid: VOLUME_UIDS.runner, owner: "agent runners" },
    { path: join(paths.harnessData, "postgres"), uid: VOLUME_UIDS.postgres, gid: VOLUME_UIDS.postgres, owner: "harness-postgres" },
    { path: join(paths.validationData, "data"), uid: VOLUME_UIDS.validation, gid: VOLUME_UIDS.validation, owner: "validation-runtime" },
    { path: join(paths.validationData, "postgres"), uid: VOLUME_UIDS.postgres, gid: VOLUME_UIDS.postgres, owner: "validation-postgres" },
    { path: paths.browserData, uid: VOLUME_UIDS.browserTool, gid: VOLUME_UIDS.browserTool, owner: "browser-tool" },
    { path: paths.logs, uid: VOLUME_UIDS.sysmon, gid: VOLUME_UIDS.sysmon, owner: "sysmon (free-space measurement only)" },
  ];
  for (const agentId of agentIds) dirs.push({ path: paths.credentials(agentId), uid: VOLUME_UIDS.runner, gid: VOLUME_UIDS.runner, owner: `agent ${agentId} credentials` });
  return dirs;
}
