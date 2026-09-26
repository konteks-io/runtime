import { createServer, connect, type Server, type Socket } from "node:net";
import type { SchemaParser } from "./parser.js";
import { createInterface } from "node:readline";
import { z } from "zod";
import { RemoteInstanceError, type RecoveryAction } from "./errors.js";
import { constantTimeEquals } from "./digest.js";
import { RuntimeRoleSchema } from "./contracts.js";

/**
 * The launcher ↔ supervisor loopback control protocol. It is the ONLY way the
 * launcher reaches the supervisor and is deliberately closed: every request is
 * a named operation with a strict schema; there is no exec, no arbitrary
 * config field, and no remote reachability (loopback bind + token file).
 *
 * Transport: JSON lines over a loopback TCP socket (one transport on macOS,
 * Linux and Windows). The first line is the auth envelope carrying a token
 * the supervisor wrote 0600 into its private data folder.
 */
export const CONTROL_SOCKET_DEFAULT_PORT = 41800;
export const CONTROL_TOKEN_FILE_NAME = "control.token";

const agentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const ControlRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status") }).strict(),
  z.object({ op: z.literal("agents") }).strict(),
  z.object({ op: z.literal("auth.status"), agentId: agentIdSchema.optional() }).strict(),
  z
    .object({
      op: z.literal("auth.login"),
      agentId: agentIdSchema,
      organization: z.boolean(),
    })
    .strict(),
  z
    .object({ op: z.literal("auth.input"), loginId: z.string().min(1), text: z.string().max(8_192) })
    .strict(),
  z.object({ op: z.literal("auth.cancel"), loginId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("auth.logout"), agentId: agentIdSchema }).strict(),
  // Managed-git key registration (ON16). Nothing here carries key material:
  // the private half is generated on the machine and never crosses this hop,
  // not even to be shown to the person who ran the command.
  z.object({ op: z.literal("git.key.add"), title: z.string().trim().min(1).max(256).optional() }).strict(),
  z.object({ op: z.literal("git.key.list") }).strict(),
  z.object({ op: z.literal("git.key.remove"), keyRef: z.string().trim().min(1).max(200) }).strict(),
  z.object({ op: z.literal("drain"), reason: z.enum(["user", "update", "remove"]) }).strict(),
  z.object({ op: z.literal("drain.status") }).strict(),
  /** Clears a launcher-initiated drain that will not be followed by a stop (e.g. an aborted update). */
  z.object({ op: z.literal("drain.cancel") }).strict(),
  z.object({ op: z.literal("doctor") }).strict(),
  /** Read-only: this computer's session previews. The on/off switch is Core's, per machine. */
  z.object({ op: z.literal("preview.status") }).strict(),
  /** Fetch and verify the release channel; reports without installing anything. */
  z.object({ op: z.literal("update.check") }).strict(),
  /** Ask the supervisor to launch the installer's transactional update in a separate process. */
  z.object({ op: z.literal("update.apply") }).strict(),
  z.object({ op: z.literal("update.status") }).strict(),
  /** The release Konteks accepts for this machine, asked with this machine's lease (WS1-093). */
  z.object({ op: z.literal("release.accepted") }).strict(),
  z
    .object({ op: z.literal("logs"), sinceSeconds: z.number().int().min(1).max(86_400 * 7) })
    .strict(),
  z.object({ op: z.literal("support.bundle") }).strict(),
  z.object({ op: z.literal("readiness.submit") }).strict(),
  z.object({ op: z.literal("revoke.pending") }).strict(),
  /** Uninstall: ask Core to drain, revoke and tombstone this runtime (W1-L2). */
  z.object({ op: z.literal("instance.retire") }).strict(),
]);
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

/** `release.accepted`: the version Konteks accepts, or null where it does not say. */
export const ReleaseAcceptedSchema = z.object({ bundleVersion: z.string().min(1).nullable() }).strict();

/** Native update coordination as reported over the loopback control socket. */
export const NativeUpdateStatusSchema = z
  .object({
    current: z.object({ bundleVersion: z.string() }).strict(),
    available: z.object({ bundleVersion: z.string(), manifestDigest: z.string() }).strict().nullable(),
    lastCheckedAt: z.string().nullable(),
    lastError: z.string().max(1_024).nullable(),
    inFlight: z.object({ startedAt: z.string(), bundleVersion: z.string(), manifestDigest: z.string(), reason: z.string(), pid: z.number().int().nullable() }).strict().nullable(),
    lastAttempt: z.object({ bundleVersion: z.string(), manifestDigest: z.string(), outcome: z.string(), startedAt: z.string(), finishedAt: z.string().nullable(), detail: z.string().nullable() }).strict().nullable(),
  })
  .strict();
export type NativeUpdateStatus = z.infer<typeof NativeUpdateStatusSchema>;

export const NativeUpdateApplySchema = z
  .object({ started: z.boolean(), reason: z.string().max(256).nullable(), pid: z.number().int().nullable(), status: NativeUpdateStatusSchema })
  .strict();
export type NativeUpdateApply = z.infer<typeof NativeUpdateApplySchema>;

export const ControlLoginEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), loginId: z.string(), agentId: agentIdSchema }).strict(),
  z.object({ kind: z.literal("display"), loginId: z.string(), text: z.string().max(16_384) }).strict(),
  z
    .object({
      kind: z.literal("open_url"),
      loginId: z.string(),
      url: z.string().url(),
      userCode: z.string().max(64).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("prompt"),
      loginId: z.string(),
      label: z.string().max(256),
      secret: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("completed"), loginId: z.string(), readiness: z.string() }).strict(),
  z
    .object({
      kind: z.literal("failed"),
      loginId: z.string(),
      code: z.string(),
      message: z.string().max(1_024),
    })
    .strict(),
]);
export type ControlLoginEvent = z.infer<typeof ControlLoginEventSchema>;

const recoveryActionsSchema = z
  .array(z.object({ kind: z.string(), agentId: z.string().optional() }).strict())
  .max(8);

export const ControlResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), id: z.string(), result: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal("error"),
      id: z.string(),
      code: z.string(),
      message: z.string().max(2_048),
      recoveryActions: recoveryActionsSchema,
    })
    .strict(),
  z.object({ kind: z.literal("event"), id: z.string(), event: ControlLoginEventSchema }).strict(),
  z.object({ kind: z.literal("done"), id: z.string() }).strict(),
]);
export type ControlResponse = z.infer<typeof ControlResponseSchema>;

const AuthEnvelopeSchema = z.object({ auth: z.string().min(16).max(256) }).strict();
const RequestEnvelopeSchema = z
  .object({ id: z.string().min(1).max(64), request: ControlRequestSchema })
  .strict();

export interface ControlEmitter {
  event(event: ControlLoginEvent): void;
}

export type ControlHandler = (request: ControlRequest, emit: ControlEmitter) => Promise<unknown>;

export interface ControlSocketServerOptions {
  token: string;
  port: number;
  handler: ControlHandler;
  /**
   * Told about an unexpected failure the caller only sees as "control
   * operation failed", so its real cause is in the runtime's log.
   */
  onUnexpectedError?: (error: unknown, operation: string) => void;
}

export interface ControlSocketServer {
  port: number;
  close(): Promise<void>;
}

const MAX_LINE_BYTES = 64 * 1024;
const LOOPBACK_HOST = "127.0.0.1";

export function startControlSocketServer(
  options: ControlSocketServerOptions,
): Promise<ControlSocketServer> {
  const server: Server = createServer((socket) => handleConnection(socket, options));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, LOOPBACK_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function handleConnection(socket: Socket, options: ControlSocketServerOptions): void {
  socket.setNoDelay(true);
  const lines = createInterface({ input: socket, terminal: false });
  // A client that resets mid-read (a `status` probe exiting early) surfaces as
  // an 'error' on the socket AND, independently, on the readline interface.
  // Unhandled, either one is an uncaught exception that takes the whole
  // supervisor down — observed live 2026-09-12 (`read ECONNRESET` emitted on
  // the Interface). A peer's failure ends that connection, nothing else.
  socket.on("error", () => socket.destroy());
  lines.on("error", () => socket.destroy());
  let authenticated = false;
  const send = (response: ControlResponse): void => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  };
  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      socket.destroy();
      return;
    }
    const parsed = safeJson(line);
    if (parsed === null) {
      socket.destroy();
      return;
    }
    if (!authenticated) {
      const auth = AuthEnvelopeSchema.safeParse(parsed);
      if (!auth.success || !constantTimeEquals(auth.data.auth, options.token)) {
        socket.destroy();
        return;
      }
      authenticated = true;
      return;
    }
    const envelope = RequestEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      send({
        kind: "error",
        id: "unknown",
        code: "control_request_invalid",
        message: "request does not match the closed control protocol",
        recoveryActions: [],
      });
      return;
    }
    const { id, request } = envelope.data;
    const emit: ControlEmitter = { event: (event) => send({ kind: "event", id, event }) };
    options
      .handler(request, emit)
      .then((result) => {
        send({ kind: "ok", id, result });
        send({ kind: "done", id });
      })
      .catch((error: unknown) => {
        if (error instanceof RemoteInstanceError) {
          send({
            kind: "error",
            id,
            code: error.code,
            message: error.message,
            recoveryActions: error.recoveryActions,
          });
        } else {
          options.onUnexpectedError?.(error, String((request as { op?: unknown }).op ?? "unknown"));
          send({
            kind: "error",
            id,
            code: "internal",
            message: "control operation failed",
            recoveryActions: [{ kind: "run_doctor" }],
          });
        }
        send({ kind: "done", id });
      });
  });
  socket.on("error", () => socket.destroy());
}

export interface ControlSocketClientOptions {
  token: string;
  port: number;
  timeoutMs?: number;
}

export interface ControlCall<T> {
  request: ControlRequest;
  schema: SchemaParser<T>;
  onEvent?: (event: ControlLoginEvent) => void;
}

function unavailable(message: string, cause?: unknown): RemoteInstanceError {
  return new RemoteInstanceError("control_socket_unavailable", message, {
    recoveryActions: [{ kind: "run_doctor" }],
    ...(cause === undefined ? {} : { cause }),
  });
}

/** One request per connection: simple, and a stuck login cannot wedge status. */
export function controlCall<T>(options: ControlSocketClientOptions, call: ControlCall<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = connect({ host: LOOPBACK_HOST, port: options.port });
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(unavailable("the supervisor did not answer in time"));
    }, options.timeoutMs ?? 30_000);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      fn();
    };
    socket.once("error", (error) => {
      finish(() => reject(unavailable("cannot reach the supervisor control socket", error)));
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ auth: options.token })}\n`);
      socket.write(`${JSON.stringify({ id, request: call.request })}\n`);
    });
    let result: unknown;
    let sawOk = false;
    let sawDone = false;
    let loginFinished = call.request.op !== "auth.login";
    const complete = (): void => {
      // auth.login acknowledges process startup before the official tooling
      // produces its interactive output. Keep its connection until a terminal
      // login event; other calls retain the one-response lifecycle.
      if (!sawDone || !loginFinished) return;
      finish(() => {
        if (!sawOk) {
          reject(new RemoteInstanceError("temporarily_unavailable", "control operation returned no result"));
          return;
        }
        const value = call.schema.safeParse(result);
        if (value.success) resolve(value.data);
        else reject(new RemoteInstanceError("temporarily_unavailable", "control result did not match its schema"));
      });
    };
    const lines = createInterface({ input: socket, terminal: false });
    // readline forwards input errors independently of the socket listener.
    // A stopped service must reject the call, not crash the launcher.
    lines.on("error", error => finish(() => reject(unavailable("cannot read the supervisor control socket", error))));
    lines.on("line", (line) => {
      const parsed = ControlResponseSchema.safeParse(safeJson(line));
      // A request the server cannot parse is answered with id "unknown". Each
      // call owns its connection and sends one request, so that error is ours.
      if (!parsed.success || (parsed.data.id !== id && !(parsed.data.kind === "error" && parsed.data.id === "unknown"))) return;
      const response = parsed.data;
      if (response.kind === "event") {
        call.onEvent?.(response.event);
        if (response.event.kind === "completed" || response.event.kind === "failed") {
          loginFinished = true;
          complete();
        }
        return;
      }
      if (response.kind === "ok") {
        result = response.result;
        sawOk = true;
        return;
      }
      if (response.kind === "error") {
        finish(() =>
          reject(
            new RemoteInstanceError("temporarily_unavailable", `${response.code}: ${response.message}`, {
              recoveryActions: response.recoveryActions as RecoveryAction[],
            }),
          ),
        );
        return;
      }
      sawDone = true;
      complete();
    });
    socket.once("close", () => finish(() => reject(unavailable("control socket closed early"))));
  });
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

/**
 * Sanitized local status projection returned by `status`. Mirrors the public
 * `RemoteInstanceView` field set the launcher may display; nothing here is a
 * path, address, key, lease, or token.
 */
export const SupervisorStatusSchema = z
  .object({
    instanceId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    administrativeStatus: z.enum([
      "provisioning",
      "active",
      "draining",
      "suspended",
      "revoked",
      "removed",
      "unknown",
    ]),
    connectivity: z
      .object({
        transport: z.enum(["relay", "https_fallback", "offline"]),
        relayConnected: z.boolean(),
        lastConnectedAt: z.string().nullable(),
        reconciliationComplete: z.boolean(),
      })
      .strict(),
    lease: z
      .object({
        mode: z.enum(["active", "drain_only", "none"]),
        expiresAt: z.string().nullable(),
        drainDeadline: z.string().nullable(),
      })
      .strict(),
    version: z
      .object({
        bundle: z.string(),
        protocol: z.string(),
        manifestDigest: z.string().nullable(),
        updateAvailable: z.boolean(),
        targetBundle: z.string().nullable(),
      })
      .strict(),
    configRevision: z.number().int().nonnegative(),
    components: z.array(
      z
        .object({
          kind: z.enum(["agent_runner"]),
          version: z.string(),
          healthStatus: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
          capabilities: z.array(z.string()),
          lastProbeAt: z.string(),
        })
        .strict(),
    ),
    roles: z.array(RuntimeRoleSchema),
    roleBindings: z.array(
      z
        .object({
          role: RuntimeRoleSchema,
          agentPreference: z.array(z.string()),
        })
        .strict(),
    ),
    utilization: z
      .object({
        acceptingWork: z.boolean(),
        activeSessions: z.number().int(),
        activeTurns: z.number().int(),
        utilizationRatio: z.number().min(0).max(1),
        softMaxConcurrent: z.number().int().optional(),
      })
      .strict(),
    pendingErase: z.number().int().nonnegative(),
    pendingRevocation: z.boolean(),
    /**
     * Whether a session preview is running on this computer, and the first
     * one's loopback port and whether a viewer reached it through the relay.
     * Always emitted: a launcher installed before 7.0.0 (a user install's
     * `<root>/bin/konteks-remote` is never replaced by an update) requires
     * both; optional so a launcher still reads a connector without them.
     */
    previewEnabled: z.boolean().optional(),
    previewExposure: z.object({ port: z.number().int(), grantPresent: z.boolean() }).strict().nullable().optional(),
    journal: z
      .object({
        assignments: z.number().int().nonnegative(),
        outboxDepth: z.number().int().nonnegative(),
        recoveryRequired: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type SupervisorStatus = z.infer<typeof SupervisorStatusSchema>;

/** `preview.status`: every session preview this connector runs or recently ran. */
export const PreviewStatusReportSchema = z
  .object({
    /** The connector advertises `preview.dev_server` (it can serve preview channels). */
    capabilityAdvertised: z.boolean(),
    idleStopMinutes: z.number().int().positive(),
    maxRunning: z.number().int().positive(),
    previews: z.array(
      z
        .object({
          sessionId: z.string(),
          state: z.enum(["not_started", "starting", "running", "failed", "stopped"]),
          url: z.string().nullable(),
          port: z.number().int().nullable(),
          command: z.string().nullable(),
          source: z.enum(["preview_yaml", "inferred"]).nullable(),
          explanation: z.string().nullable(),
          message: z.string(),
          startedAt: z.string().nullable(),
          readyAt: z.string().nullable(),
          viewerConnected: z.boolean(),
        })
        .strict(),
    ),
    lastFailure: z.object({ at: z.string(), message: z.string() }).strict().nullable(),
  })
  .strict();
export type PreviewStatusReport = z.infer<typeof PreviewStatusReportSchema>;

export const DoctorCheckSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["pass", "warn", "fail", "skip"]),
    detail: z.string().max(1_024),
    recoveryActions: recoveryActionsSchema,
  })
  .strict();
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorReportSchema = z
  .object({ checks: z.array(DoctorCheckSchema), generatedAt: z.string() })
  .strict();
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
