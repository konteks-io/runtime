import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  REMOTE_INSTANCE_PROTOCOL_VERSION,
  PlanningControllerTerminalDirectiveSchema,
  RemoteInstanceError,
  SystemClock,
  createLogger,
  parseRfc3339,
  signBody,
  type AgentTurnUsageObservation,
  type ControlAck,
  type ControlHandler,
  type ControlLoginEvent,
  type GatewayCallObservation,
  type HeartbeatResult,
  type InstanceKeyPair,
  type JsonValue,
  type Logger,
  type RemoteWorkAssignment,
  type RemoteWorkKind,
  type RelayRuntimeHandshakeResult,
  type SupervisorStatus,
} from "@konteks/remote-common";
import { EmbeddedReleaseRootSchema, ReleaseManifestSchema, loadReleaseRootsFile, selectNativeModelCapabilityMappings, verifyNativeRelease, type VerifiedNativeRelease, type EmbeddedReleaseRoot, type ReleaseManifest } from "@konteks/remote-release";
import type { RunnerConfig } from "@konteks/remote-agent-runner";
import { SignalSampler } from "@konteks/remote-sysmon";
import { loadSupervisorConfig, parseRunnerUrls, type SupervisorConfig } from "./config.js";
import { CoreClient, LEASE_AUDIENCE } from "./core/client.js";
import { CoreSignatureVerifier } from "./control/core-signature.js";
import { CancellationReceiver } from "./control/cancellation-receiver.js";
import { PermissionAnswerReceiver } from "./control/permission-answer-receiver.js";
import { CancellationReplay } from "./control/cancellation-replay.js";
import { ControlHandlers, compareSemver } from "./control/handlers.js";
import { ConfigurationAckDelivery } from "./control/configuration-ack-delivery.js";
import { GatewayClient } from "./gateway-client.js";
import { HeartbeatPublisher } from "./heartbeat/heartbeat.js";
import { startInternalServer, type InternalServer } from "./internal/server.js";
import { InventoryCollector, type InventorySnapshot } from "./inventory/collector.js";
import { deriveAdvertisedRoles, type RoleBinding, type RoleCapabilityInputs } from "./inventory/roles.js";
import { LocalGit, OnboardScratch } from "./onboard/git.js";
import { GitKeyStore, sshConfigPath } from "./onboard/git-keys.js";
import { RawFileApi } from "./onboard/raw-file-api.js";
import { createRemoteResolver, type ManagedGitBinding } from "./onboard/remotes.js";
import { OnboardWorkCarrier, type OnboardWorkAssignment } from "./onboard/carrier.js";
import type { PlatformMcpEntry } from "./work/components.js";
import { LeaseState, decodeLeaseClaims, decodeStoredLeaseClaims, leaseRecordFromClaims } from "./lease/lease.js";
import { channelOfId, coreChannelId, CORE_BOUND_CHANNELS } from "./relay/channel-ids.js";
import { PreviewChannel } from "./preview/preview-channel.js";
import { provisioningCredentialIsExpired, refreshProvisioningCredential, submitReadiness } from "./provisioning/activation.js";
import { Reconciliation } from "./reconnect/reconciliation.js";
import { ChannelMux } from "./relay/channel-mux.js";
import { RelayClient } from "./relay/relay-client.js";
import { RunnerClient } from "./runner-client.js";
import type { RunnerPort } from "./runner-port.js";
import { NativeRunner, type NativeRunnerOptions } from "./native/runner.js";
import { ModelCapabilitySnapshotProducer } from "./native/model-capability-snapshot.js";
import { NativeInventoryCollector } from "./native/inventory.js";
import { NativeInputClient } from "./native/input-client.js";
import { NativeOutputClient } from "./native/output-client.js";
import { createRetainedDeliveryOutputRecovery } from "./native/output-recovery.js";
import { createNativeInputPreparer } from "./native/input-preparer.js";
import { createNativeReadyRegistrar } from "./native/execution-ready.js";
import type { NativeGitTool } from "./native/git-workspace.js";
import { verifyInstalledNativeBridges } from "./native/installed.js";
import { acquireNativeRootLock, type NativeRootLock } from "./native/root-lock.js";
import { NativeCodexAppServerOwner, type NativeCodexAppServerOwnerOptions } from "./native/codex-app-server-owner.js";
import { startNativeAgents } from "./native/start-native-agents.js";
import { StateMutationGate } from "./state/mutation-gate.js";
import type { RelayedSessionDeps } from "./session/relayed-session.js";
import { PermissionBroker } from "./session/permissions.js";
import { EvaluatorPolicyResponder } from "./session/policy-responder.js";
import { createWorkspaceToolPolicy } from "./session/workspace-tool-policy.js";
import { SupervisorJournal } from "./state/journal.js";
import { DurableOutbox } from "./state/outbox.js";
import { DEFAULT_CONFIG, MACHINE_KEY_LOST, SupervisorStore, type ConfigRecord } from "./state/store.js";
import { buildSupportBundle } from "./support/bundle.js";
import { runDoctor } from "./support/doctor.js";
import { HttpsFallbackTransport } from "./transport/https-fallback.js";
import { RecoveryAuthority } from "./transport/recovery-authority.js";
import { AssignmentSender } from "./work/assignment-sender.js";
import { RelayTransport, TransportManager } from "./transport/relay-transport.js";
import type { InboundMessage } from "./transport/transport.js";
import { HarnessProtocolAdapter, tokenFromFile } from "./work/harness-protocol.js";
import { ValidationProtocolAdapter, secretFromFile } from "./work/validation-protocol.js";
import { WorkOrchestrator } from "./work/orchestrator.js";
import { PlanningTerminalDirectiveProcessor } from "./work/planning-terminal-directives.js";
import { ControllerDirectivePoller } from "./work/controller-directive-poller.js";
import { DurableSearchAssignmentCarrier } from "./work/search-assignment-carrier.js";
import { NativeUpdateCoordinator, type NativeUpdateCoordinatorOptions } from "./native/update.js";
import { evaluateHeartbeatLiveness } from "./heartbeat/liveness.js";

/**
 * The composition root: wires state, transport, heartbeat, control, work,
 * sessions, preview, and the loopback control socket into one supervisor.
 */
const ALL_KINDS: RemoteWorkKind[] = ["planning", "delivery", "validation", "preview", "qa", "assistant_execution", "search_generation"];

/** bb releases sessions idle for 30 minutes, checked every 5 minutes. */
const IDLE_SESSION_RELEASE_MS = 30 * 60_000;
const IDLE_SESSION_SWEEP_MS = 5 * 60_000;
const LIVENESS_CHECK_MS = 30_000;
const LIVENESS_MIN_BUDGET_MS = 5 * 60_000;

export interface SupervisorOptions {
  /** Native only: called once when no heartbeat has been attempted for longer
   * than the publisher's budget. The service wires it to a non-zero shutdown so
   * the service manager replaces a silent process. */
  onLivenessLost?: (detail: Record<string, unknown>) => void;
  native?: {
    /** Public trust provided by the verified native executable, never by writable install metadata. */
    trustedRoots: readonly EmbeddedReleaseRoot[];
    runners: RunnerConfig[];
    /** Tests/embedding may override; installed native service uses the production preparer. */
    prepareInputs?: NonNullable<RelayedSessionDeps["prepareInputs"]>;
    git?: NativeGitTool;
    /** Shared object cache across every configured local agent. */
    repositoryCacheRoot?: string;
    runtimeOptions?: NativeRunnerOptions["runtimeOptions"];
    /** Test/embedding seam for the independently supervised shared Codex owner. */
    codexAppServerOptions?: Omit<NativeCodexAppServerOwnerOptions, "config">;
    /** Self-update policy; absent means the connector only reports `update_required`. */
    update?: Pick<NativeUpdateCoordinatorOptions, "fetchManifest" | "launch" | "readLedger" | "checkIntervalMs" | "initialDelayMs" | "maxAttemptsPerRelease" | "attemptWindowMs" | "staleAttemptMs">;
  };
}

export class Supervisor {
  readonly config: SupervisorConfig;
  readonly logger: Logger;
  readonly clock = new SystemClock();
  readonly store: SupervisorStore;
  readonly journal: SupervisorJournal;
  readonly outbox: DurableOutbox;
  readonly lease: LeaseState;
  private key!: InstanceKeyPair;
  private instanceId: string | null = null;
  private workspaceId: string | null = null;
  /** Present exactly where this build speaks the 2.0 assignment protocol. */
  private assignmentSender: AssignmentSender | null = null;
  private administrativeStatus: SupervisorStatus["administrativeStatus"] = "unknown";
  private release: ReleaseManifest | null = null;
  private nativeRelease: VerifiedNativeRelease | null = null;
  private modelCapabilities: ModelCapabilitySnapshotProducer | null = null;
  private roots: EmbeddedReleaseRoot[] = [];
  private manifestDigest = "";
  private configuration: ConfigRecord["configuration"] = DEFAULT_CONFIG;
  private roleBindings: RoleBinding[] = [];
  private draining = false;
  private drainReason: string | null = null;
  /** Non-null only for a Core directive; the local operator cannot lift that one. */
  private drainDeadline: string | null = null;
  private pendingRevocation = false;
  private lastSnapshot: InventorySnapshot | null = null;
  /**
   * The machine's own git (OB6 §5). It is a field rather than a dependency
   * because every onboard lane — role advertisement, the evidence collector
   * and the relocation worker — must use the SAME access, or a runtime could
   * advertise a capability one path has and another does not.
   */
  private readonly git = new LocalGit();
  /** Cached so every onboard lane resolves the same managed host and key. */
  private managedGitBinding: ManagedGitBinding | null = null;
  private readonly logLines: string[] = [];

  core!: CoreClient;
  gateway!: GatewayClient;
  mux!: ChannelMux;
  relay!: RelayClient | null;
  transport!: TransportManager;
  inventory!: InventoryCollector | NativeInventoryCollector;
  heartbeat!: HeartbeatPublisher;
  control!: ControlHandlers;
  private configurationAcks!: ConfigurationAckDelivery;
  work!: WorkOrchestrator;
  private planningTerminal!: PlanningTerminalDirectiveProcessor;
  private planningDirectivePoller: ControllerDirectivePoller | null = null;
  reconciliation!: Reconciliation;
  preview!: PreviewChannel;
  broker!: PermissionBroker;
  internal!: InternalServer;
  readonly runners = new Map<string, RunnerPort>();
  private readonly nativeRunners: NativeRunner[] = [];
  private nativeCodexOwner: NativeCodexAppServerOwner | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;
  private nativeOwnership: NativeRootLock | null = null;
  private readonly runnerIncarnation = randomUUID();
  private readonly stateMutations: StateMutationGate | undefined;
  private heartbeatIntervalSeconds: number | null = null;
  private leaseAuthorityEpoch = 0;
  private leaseMutation: Promise<void> = Promise.resolve();
  private leaseAcquisition: Promise<void> = Promise.resolve();
  private leaseLossCleanup: Promise<void> | null = null;
  private leaseLossCleanupFailed = false;
  private leaseRestorationAllowed = false;
  private drainTimer: NodeJS.Timeout | null = null;
  private drainEpoch = 0;
  private pullTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private updates: NativeUpdateCoordinator | null = null;
  private muxTimer: NodeJS.Timeout | null = null;
  private cancellationTimer: NodeJS.Timeout | null = null;
  private cancellationReplay: CancellationReplay | null = null;
  private configurationTimer: NodeJS.Timeout | null = null;
  private configurationRefresh: Promise<void> | null = null;
  private activeLoopStarted = false;
  private ordinaryHeartbeatStarted = false;
  private activeLoopStarting: Promise<void> | null = null;
  private recoveryRetryTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private livenessWatchingSince: number | null = null;
  private livenessQuietWarned = false;
  private pendingHeartbeatTimer: NodeJS.Timeout | null = null;
  private readonly activeLogins = new Map<string, { agentId: string; emit: (event: ControlLoginEvent) => void }>();

  constructor(config: SupervisorConfig = loadSupervisorConfig(), private readonly options: SupervisorOptions = {}) {
    this.config = config;
    if (this.native) {
      const { gateway: _gateway, ...policy } = DEFAULT_CONFIG;
      this.configuration = { ...policy, deploymentKind: "native_connector", roleBindings: [] };
    }
    this.logger = createLogger({ name: "supervisor" });
    this.stateMutations = this.native ? new StateMutationGate(() => {
      if (!this.nativeOwnership) throw new RemoteInstanceError("temporarily_unavailable", "Native state ownership has not been acquired.");
      this.nativeOwnership.assertOwned();
    }) : undefined;
    this.store = new SupervisorStore(config.SUPERVISOR_DATA_DIR, this.stateMutations?.run);
    this.journal = new SupervisorJournal(this.store.path("journal"), this.stateMutations?.run);
    this.outbox = new DurableOutbox(this.store.path("outbox"), this.stateMutations?.run);
    this.lease = new LeaseState(this.clock);
  }

  // ── Startup ────────────────────────────────────────────────────────────────

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new RemoteInstanceError("temporarily_unavailable", "Supervisor is stopping."));
    this.startPromise ??= this.startImpl();
    return this.startPromise;
  }

  private get native(): boolean { return this.config.SUPERVISOR_DEPLOYMENT_KIND === "native_connector"; }

  private async startImpl(): Promise<void> {
    if (this.native !== Boolean(this.options.native)) throw new RemoteInstanceError("protocol_incompatible", "Native supervisor composition requires explicit native dependencies.");
    if (this.native) this.nativeOwnership = acquireNativeRootLock(this.config.SUPERVISOR_DATA_DIR, { onLost: () => {
      this.logger.error("native state ownership lost; stopping without reacquisition");
      void this.stop().catch(() => this.logger.error("native ownership-loss shutdown failed"));
    } });
    await this.store.init();
    await this.journal.load();
    await this.outbox.load();
    // A native machine that has an identity but no key has lost the only
    // proof of who it is. A fresh key would be refused by Core on every call
    // while the process looked alive (W1-L1), so it stops and says so;
    // `konteks-remote onboard` connects the machine again as a new runtime.
    const knownIdentity = this.native ? await this.store.identity().catch(() => null) : null;
    const existingKey = knownIdentity ? await this.store.loadInstanceKey() : null;
    if (knownIdentity && !existingKey) {
      throw new RemoteInstanceError("install_state_corrupt", MACHINE_KEY_LOST);
    }
    this.key = existingKey ?? await this.store.loadOrCreateInstanceKey();
    this.roots = this.native
      ? (this.options.native!.trustedRoots ?? []).map(root => EmbeddedReleaseRootSchema.parse(root))
      : await loadReleaseRootsFile(this.config.SUPERVISOR_RELEASE_ROOTS_FILE).catch(() => []);
    this.release = await readFile(this.config.SUPERVISOR_RELEASE_MANIFEST_FILE, "utf8")
      .then((text) => ReleaseManifestSchema.parse(JSON.parse(text)))
      .catch(() => null);
    const identity = await this.store.identity();
    const manifest = await this.store.manifest();
    this.instanceId = identity?.instanceId ?? null;
    this.workspaceId = identity?.workspaceId ?? null;
    this.administrativeStatus = identity?.administrativeStatus ?? "unknown";
    this.manifestDigest = manifest?.manifestDigest ?? "";
    if (this.native) {
      if (!identity || !manifest) throw new RemoteInstanceError("install_state_corrupt", "Native activation and release state are required before startup.");
      try {
        this.nativeRelease = verifyNativeRelease(JSON.parse(await readFile(this.config.SUPERVISOR_RELEASE_MANIFEST_FILE, "utf8")), this.roots, this.clock.now());
        const exchange = verifyNativeRelease(manifest.manifest, this.roots, this.clock.now());
        if (manifest.manifestDigest !== exchange.manifest.digest || this.nativeRelease.manifest.bundleVersion !== this.config.SUPERVISOR_BUNDLE_VERSION) throw new Error("release mismatch");
        await verifyInstalledNativeBridges(this.nativeRelease, this.options.native!.runners, { os: this.config.SUPERVISOR_PLATFORM_OS, architecture: this.config.SUPERVISOR_PLATFORM_ARCH });
        if (manifest.manifestDigest !== this.nativeRelease.manifest.digest) {
          // D160 release evolution can be interrupted after the immutable
          // successor and runtime record advance but before this projection.
          // Only a strictly newer independently verified installed release may
          // repair it; downgrade and same-version digest substitution refuse.
          if (compareSemver(this.nativeRelease.manifest.bundleVersion, exchange.manifest.bundleVersion) <= 0) throw new Error("release projection mismatch");
          await this.store.saveManifest(this.nativeRelease.manifest, this.nativeRelease.manifest.digest);
        }
        this.manifestDigest = this.nativeRelease.manifest.digest;
      } catch { throw new RemoteInstanceError("bundle_untrusted", "Native startup requires matching signed activation and installed release artifacts."); }
    }
    const storedLease = await this.store.lease();
    if (storedLease) {
      if (this.native) {
        const claims = decodeStoredLeaseClaims(storedLease.lease, { instanceId: this.instanceId!, audience: LEASE_AUDIENCE, deploymentKind: "native_connector" });
        if (claims.workspace_id !== this.workspaceId || storedLease.workspaceId !== this.workspaceId) throw new RemoteInstanceError("registration_mismatch", "lease workspace does not match the native activation");
        const expected = leaseRecordFromClaims(storedLease.lease, claims);
        if (storedLease.mode !== expected.mode
          || Date.parse(storedLease.expiresAt) !== Date.parse(expected.expiresAt)
          || Date.parse(storedLease.issuedAt) !== Date.parse(expected.issuedAt)
          || (storedLease.drainDeadline === null ? null : Date.parse(storedLease.drainDeadline))
            !== (expected.drainDeadline === null ? null : Date.parse(expected.drainDeadline))) {
          throw new RemoteInstanceError("registration_mismatch", "stored lease metadata does not match its decoded claims");
        }
      }
      this.lease.set(storedLease);
      this.workspaceId = storedLease.workspaceId;
    }

    this.core = new CoreClient({
      baseUrl: this.config.SUPERVISOR_CORE_URL,
      clock: this.clock,
      key: () => this.key,
      credential: () => this.lease.current()?.lease ?? this.provisioningCredential,
    });
    this.configurationAcks = new ConfigurationAckDelivery({ outbox: this.outbox, core: this.core, instanceId: () => this.instanceId ?? "", clock: this.clock, canSend: () => !this.stopping && Boolean(this.instanceId) });
    if (this.native) {
      const sharedCodex = this.options.native!.runners.find(config => config.RUNNER_AGENT_ID === "codex" && config.RUNNER_NATIVE_CODEX_SOCKET !== undefined);
      if (sharedCodex) this.nativeCodexOwner = new NativeCodexAppServerOwner({
        ...this.options.native!.codexAppServerOptions,
        config: sharedCodex,
        onRestartFailure: error => this.logger.warn({ err: error }, "shared Codex app-server restart failed; retrying"),
      });
      for (const config of this.options.native!.runners) {
        const runner = new NativeRunner({ instanceId: identity!.instanceId, config,
          executionBridgeLimit: () => Math.min(4, this.configuration.softMaxConcurrent ?? this.config.SUPERVISOR_SOFT_MAX_CONCURRENT ?? 4),
          onEvent: event => { void this.onRunnerEvent(config.RUNNER_AGENT_ID, event).catch(error => this.logger.warn({ err: error }, "native runner event failed")); }, ...(this.options.native!.runtimeOptions ? { runtimeOptions: this.options.native!.runtimeOptions } : {}) });
        this.nativeRunners.push(runner);
        this.runners.set(runner.agentId, runner);
      }
      this.inventory = new NativeInventoryCollector({ runners: this.runners, sampler: new SignalSampler(this.config.SUPERVISOR_DATA_DIR), bundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
        gitVersion: () => this.git.version(),
        executionPermitsReady: () => {
          // Native sessionDeps below always composes NativeExecutionGate.
          // Advertise only once that work owner exists and is still owned.
          if (!this.work || !this.nativeOwnership || this.stopping) return false;
          try { this.nativeOwnership.assertOwned(); return true; } catch { return false; }
        },
        cancellationDeliveryReady: () => {
          if (!this.relay || !this.cancellationReplay || !this.nativeOwnership || this.stopping) return false;
          try { this.nativeOwnership.assertOwned(); return true; } catch { return false; }
        },
        deliveryExecutionPermitsReady: () => {
          // Native sessionDeps composes the delivery-aware execution gate and
          // dedicated Core consume/check methods. Old Assistant-only bundles
          // must never advertise this separate protocol.
          if (!this.work || !this.nativeOwnership || this.stopping || this.lease.mode() !== 'active') return false;
          try { this.nativeOwnership.assertOwned(); return true; } catch { return false; }
        },
      });
      this.modelCapabilities = new ModelCapabilitySnapshotProducer({
        clock: this.clock, instanceId: () => this.instanceId ?? "", runnerIncarnation: () => this.runnerIncarnation,
        manifestId: () => this.journal.recovery.current(this.instanceId ?? "", this.runnerIncarnation)?.manifest?.manifestId ?? null,
        mappings: () => this.nativeRelease ? selectNativeModelCapabilityMappings(this.nativeRelease) : [],
        discover: async (agentId, configId) => {
          const runner = this.nativeRunners.find(candidate => candidate.agentId === agentId);
          if (!runner) throw new RemoteInstanceError("agent_unavailable", "Reviewed model mapping has no installed native runner.");
          return runner.discoverModelCapability(configId);
        },
      });
    } else {
    this.gateway = new GatewayClient(this.config.SUPERVISOR_GATEWAY_ADMIN_URL);
    for (const [agentId, url] of parseRunnerUrls(this.config.SUPERVISOR_RUNNER_URLS)) {
      const runner = new RunnerClient({ agentId, baseUrl: url, onEvent: (event) => void this.onRunnerEvent(agentId, event) });
      this.runners.set(agentId, runner);
    }
    this.inventory = new InventoryCollector({
      harnessUrl: this.config.SUPERVISOR_HARNESS_URL,
      validationUrl: this.config.SUPERVISOR_VALIDATION_URL,
      gatewayAdminUrl: this.config.SUPERVISOR_GATEWAY_ADMIN_URL,
      sysmonUrl: this.config.SUPERVISOR_SYSMON_URL,
      browserToolUrl: this.config.SUPERVISOR_BROWSER_TOOL_URL,
      runnerUrls: parseRunnerUrls(this.config.SUPERVISOR_RUNNER_URLS),
      gitVersion: () => this.git.version(),
    });
    }

    this.mux = new ChannelMux({
      recoveryAuthority: () => this.recoveryAuthority(),
      clock: this.clock,
      key: () => this.key,
      ackIntervalSeconds: this.config.SUPERVISOR_ACK_INTERVAL_SECONDS,
      ackEveryFrames: this.config.SUPERVISOR_ACK_EVERY_FRAMES,
      replayBufferBytes: this.config.SUPERVISOR_REPLAY_BUFFER_BYTES,
      replayBufferAgeMs: this.config.SUPERVISOR_REPLAY_BUFFER_AGE_MS,
      emit: (envelope) => this.relay?.emit(envelope) ?? false,
      onFrame: (frame) => this.onInbound({ channel: frame.channel, channelId: frame.channelId, body: frame.body }),
      onAssignmentRequestAck: async (ack) => {
        const sender = this.assignmentSender;
        if (!sender) throw new RemoteInstanceError("assignment_channel_invalid", "No native assignment ACK owner is active.");
        await sender.observeRelayedRequestAck(ack, () => {
          if (this.mux.connectionEpoch !== ack.connectionEpoch) throw new RemoteInstanceError("recovery_required", "Assignment ACK socket epoch changed.");
        });
      },
      onAssignmentFrame: async (frame) => {
        const sender = this.assignmentSender;
        if (!sender) throw new RemoteInstanceError("assignment_channel_invalid", "No native assignment reply owner is active.");
        const reference = { requestSequence: frame.body.requestSequence, requestDigest: frame.body.requestDigest, requestKind: frame.body.requestKind };
        return sender.acceptRelayed(frame, body => this.work.onAssignmentMessage(body, reference), () => {
          if (this.mux.connectionEpoch !== frame.connectionEpoch) throw new RemoteInstanceError("recovery_required", "Assignment reply socket epoch changed.");
        });
      },
      // This callback selects the retained D143 carrier, even before a sender
      // has cursors. Keep its composition aligned with assignmentSender below.
      ...(String(REMOTE_INSTANCE_PROTOCOL_VERSION) === "2.0"
        ? { assignmentCursors: () => this.assignmentSender?.relayCursors() ?? null }
        : {}),
      onStall: (channelId) => this.relay?.rehandshake(`stall:${channelId}`),
      onReset: (channelId) => void this.onChannelReset(channelId)
        .catch(error => this.logger.error({ err: error, channelId }, "channel reset handling failed")),
      persistCursors: (cursors) => this.store.saveCursors(cursors),
      persistRelayState: (state) => this.store.saveRelayState(state),
    });
    const relayState = await this.store.relayState();
    if (relayState) this.mux.restoreDurableState(relayState, (channelId) => channelOf(channelId));
    else this.mux.restoreCursors(await this.store.cursors(), (channelId) => channelOf(channelId));
    if (this.instanceId) this.openCoreChannels(this.instanceId);

    const verifier = new CoreSignatureVerifier(this.roots);
    this.relay = this.config.SUPERVISOR_RELAY_URL
      ? new RelayClient({
          relayUrl: this.config.SUPERVISOR_RELAY_URL,
          instanceId: () => this.instanceId ?? "",
          runnerIncarnation: () => this.runnerIncarnation,
          appliedManifestId: () => this.recoveryAuthority() ? this.journal.recovery.current(this.instanceId ?? "", this.runnerIncarnation)?.manifest?.manifestId ?? null : null,
          lease: () => this.lease.current()?.lease ?? null,
          key: () => this.key,
          clock: this.clock,
          mux: this.mux,
          outboundHighWaterBytes: Math.max(64 * 1024, Math.floor(this.config.SUPERVISOR_REPLAY_BUFFER_BYTES / 2)),
          outboundLowWaterBytes: Math.max(32 * 1024, Math.floor(this.config.SUPERVISOR_REPLAY_BUFFER_BYTES / 4)),
          outboundMaxBytes: this.config.SUPERVISOR_REPLAY_BUFFER_BYTES,
          onStateChange: () => this.transport.evaluate(),
          validateHandshake: result => this.validateRelayHandshake(result),
          onConnected: result => this.onRelayConnected(result),
          onPermissionAnswer: async (request, connection) => {
            const producer = this.config.SUPERVISOR_CORE_PERMISSION_ANSWER_PRODUCER;
            if (!producer) throw new RemoteInstanceError("recovery_required", "Core answer producer is not configured");
            const lease = this.lease.current(), instanceId = this.instanceId, workspaceId = this.workspaceId;
            const runnerIncarnation = this.runnerIncarnation, ownership = this.nativeOwnership;
            const accepted = this.recoveryAuthority();
            const receiver = new PermissionAnswerReceiver({
              verifier, core: this.core, coreProducer: producer, now: () => this.clock.coreNow(),
              deliver: (operation, claims, guard) => this.work.onPermissionAnswer(operation, claims, guard),
              captureConnection: () => lease && instanceId && workspaceId && ownership && accepted ? {
                instanceId, workspaceId, runnerIncarnation, connectionEpoch: connection.connectionEpoch, leaseExpiresAt: lease.expiresAt,
                assertCurrent: () => {
                  connection.assertCurrent();
                  if (this.stopping || this.nativeOwnership !== ownership || this.lease.current() !== lease ||
                    this.instanceId !== instanceId || this.workspaceId !== workspaceId || this.runnerIncarnation !== runnerIncarnation ||
                    this.recoveryAuthority() !== accepted || !this.lease.canPullNewWork()) {
                    throw new RemoteInstanceError("recovery_required", "Answer execution ownership is not current");
                  }
                  ownership.assertOwned();
                },
              } : null,
            });
            await receiver.receive(request);
          },
          onCancellation: async (request, connection) => {
            const lease = this.lease.current();
            const instanceId = this.instanceId;
            const workspaceId = this.workspaceId;
            const runnerIncarnation = this.runnerIncarnation;
            const ownership = this.nativeOwnership;
            const receiver = new CancellationReceiver({
              core: this.core,
              onPersisted: record => this.cancellationReplay?.notify(record),
              verifier, inbox: this.journal.cancellations, claims: this.journal.execution,
              now: () => this.clock.coreNow(),
              captureConnection: () => lease && instanceId && workspaceId && ownership ? {
                instanceId, workspaceId, runnerIncarnation, connectionEpoch: connection.connectionEpoch,
                leaseExpiresAt: lease.expiresAt,
                assertCurrent: () => {
                  connection.assertCurrent();
                  if (this.stopping || this.nativeOwnership !== ownership || this.lease.current() !== lease ||
                      this.instanceId !== instanceId || this.workspaceId !== workspaceId ||
                      this.runnerIncarnation !== runnerIncarnation) {
                    throw new RemoteInstanceError("recovery_required", "Cancellation native ownership is not current");
                  }
                  ownership.assertOwned();
                },
              } : null,
            });
            await receiver.receive(request);
          },
        })
      : null;
    // The D143 cutover is decided by the protocol this build speaks, not by
    // inspecting a reply: Core refuses the bare routes under 2.0, and a 1.0
    // build has no retained stream to send from. One constant, both halves.
    this.assignmentSender = String(REMOTE_INSTANCE_PROTOCOL_VERSION) === "2.0"
      ? new AssignmentSender({
        clock: this.clock,
        journal: this.journal,
        core: this.core,
        instanceId: () => this.instanceId ?? "",
        workspaceId: () => this.workspaceId ?? "",
        runnerIncarnation: () => this.runnerIncarnation,
        originManifestId: () => this.acceptedManifestId(),
        captureRecoveryAuthority: () => new RecoveryAuthority(() => this.recoveryAuthority()).capture("assignment"),
        captureClaimAuthority: admission => this.work.capturePendingClaimAuthority(admission),
        assertOwned: () => {
          if (this.stopping || !this.nativeOwnership) throw new RemoteInstanceError("recovery_required", "Native execution owner is unavailable.");
          this.nativeOwnership.assertOwned();
        },
      })
      : null;
    const https = new HttpsFallbackTransport({
      core: this.core, instanceId: () => this.instanceId ?? "",
      pollIntervalMs: this.config.SUPERVISOR_HTTPS_FALLBACK_POLL_MS,
      recoveryAuthority: () => this.recoveryAuthority(),
      ...(this.assignmentSender ? { sender: this.assignmentSender } : {}),
    });
    let relayHandler: ((message: InboundMessage) => void | Promise<void>) | null = null;
    const relayTransport = this.relay ? new RelayTransport(this.relay, this.mux, { setHandler: (handler) => (relayHandler = handler) }) : null;
    this.transport = new TransportManager(relayTransport, https, 3, () => {
      const status = this.relay?.status();
      return { consecutiveFailures: status?.consecutiveFailures ?? 0, connected: status?.state === "connected" };
    });
    this.transport.onInbound((message) => this.onInbound(message));
    void relayHandler;

    this.control = new ControlHandlers({
      store: this.store,
      journal: this.journal,
      clock: this.clock,
      key: () => this.key,
      replaceKey: async (next) => {
        await this.store.replaceInstanceKey(next);
        this.key = next;
      },
      verifier,
      instanceId: () => this.instanceId ?? "",
      bundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
      protocolVersion: String(REMOTE_INSTANCE_PROTOCOL_VERSION),
      manifestDigest: () => this.manifestDigest,
      deploymentKind: this.native ? "native_connector" : "appliance",
      onConfigurationApplied: (configuration) => {
        this.configuration = configuration;
        this.roleBindings = (configuration.roleBindings ?? []).map(binding => ({ role: binding.role, agentPreference: [...binding.agentPreference] }));
      },
      applyGatewayConfig: async (gatewayConfig) => {
        if (this.native) return "unsupported_revision";
        return this.gateway.applyConfig(gatewayConfig);
      },
      localCapacity: () => Math.max(1, (this.lastSnapshot?.agents.filter((agent) => agent.readiness === "ready").length ?? 1) * 4),
      onDrain: async (directive) => this.beginDrain(directive.reason, directive.drainDeadline ?? null),
      eraseAssignments: (ids) => this.eraseAssignments(ids),
      eraseAll: () => this.eraseAll(),
      onUpdateRequired: (policy) => {
        if (this.updates) this.updates.onUpdateRequired(policy);
        else this.logger.warn({ minimumSupportedBundle: policy.minimumSupportedBundle }, "update_required: bundle below Core's minimum");
      },
      sendAck: (ack) => this.sendControlAck(ack),
    });
    await this.control.load();

    this.broker = new PermissionBroker({ clock: this.clock, deadlineSeconds: () => this.configuration.permissionResponderDeadlineSeconds, onTimeout: async (request) => this.work.onPermissionTimeout(request) });
    // Each component is addressed through its OWN local contract and its own
    // provisioned secret; the supervisor never invents a shared protocol.
    const harnessToken = tokenFromFile(this.config.SUPERVISOR_HARNESS_COMPONENT_TOKEN_FILE);
    const validationToken = secretFromFile(this.config.SUPERVISOR_VALIDATION_COMPONENT_TOKEN_FILE, "the Validation Runtime component token");
    const applianceComponents = this.native ? null : {
      harness: new HarnessProtocolAdapter({ baseUrl: this.config.SUPERVISOR_HARNESS_URL, token: harnessToken, clock: this.clock }),
      validation_runtime: new ValidationProtocolAdapter({ baseUrl: this.config.SUPERVISOR_VALIDATION_URL, secret: secretFromFile(this.config.SUPERVISOR_VALIDATION_DISPATCH_SECRET_FILE), clock: this.clock }),
    };
    const components = applianceComponents ?? {};
    this.work = new WorkOrchestrator({
      verifyCancellation: directive => verifier.verify(directive, directive.signature),
      ...(this.assignmentSender ? { assignmentSender: this.assignmentSender } : {}),
      deploymentKind: this.config.SUPERVISOR_DEPLOYMENT_KIND,
      runnerIncarnation: () => this.runnerIncarnation,
      assertOwned: () => {
        if (this.stopping || !this.nativeOwnership) throw new RemoteInstanceError("recovery_required", "Native execution owner is unavailable.");
        this.nativeOwnership.assertOwned();
      },
      clock: this.clock,
      journal: this.journal,
      outbox: this.outbox,
      transport: this.transport,
      lease: this.lease,
      instanceId: () => this.instanceId ?? "",
      workspaceId: () => this.workspaceId,
      agents: () => this.lastSnapshot?.agents ?? [],
      roleBindings: () => this.roleBindings,
      advertisedRoles: () => deriveAdvertisedRoles(this.roleBindings, this.lastSnapshot?.agents ?? [], this.roleCapabilityInputs()),
      browserToolAvailable: () => this.lastSnapshot?.browserToolAvailable ?? false,
      roleCapabilityInputs: () => this.roleCapabilityInputs(),
      acceptedKinds: () => ALL_KINDS,
      instanceEvidencePolicy: () => this.configuration.evidenceUpload,
      draining: () => this.draining,
      reconciliationComplete: () => this.reconciliation.isComplete,
      recoveryAuthority: () => this.recoveryAuthority(),
      reportDeliveryAllowed: () => this.recoveryAuthority() !== null,
      ...(this.native ? { recoverPendingDeliveryOutput: createRetainedDeliveryOutputRecovery({
        roots: this.options.native!.runners.map(config => config.RUNNER_WORKSPACE_DIR),
        journal: this.journal,
        mutate: this.stateMutations!.run,
        logger: this.logger,
        client: () => new NativeOutputClient({
          baseUrl: this.config.SUPERVISOR_CORE_URL, clock: this.clock,
          credential: () => this.lease.mode() === "active" ? this.lease.current()?.lease ?? null : null,
        }),
      }) } : {}),
      headroom: () => this.headroom(),
      maxPullItems: this.config.SUPERVISOR_PULL_MAX_ITEMS,
      components,
      searchController: new DurableSearchAssignmentCarrier(this.journal, this.clock),
      onboardCarrier: this.onboardCarrier(),
      softMaxConcurrent: () => this.configuration.softMaxConcurrent,
      bridgeDigest: (agentId) => this.nativeRelease?.manifest.nativeArtifacts?.find(artifact => artifact.agentId === agentId)?.digest ?? this.release?.agentBridges.find((bridge) => bridge.agentId === agentId)?.digest,
      redeemPlatformMcp: (assignment) => this.redeemPlatformMcp(assignment),
      fetchWorkload: (assignment) => this.core.fetchWorkload(this.instanceId ?? "", assignment.id),
      runners: this.runners,
      sessionDeps: (assignment, runner) => ({
        clock: this.clock,
        journal: this.journal,
        transport: this.transport,
        runner,
        policy: new EvaluatorPolicyResponder(this.native ? createWorkspaceToolPolicy() : null, () => this.configuration.humanDeferralAllowed && assignment.policy.humanDeferralAllowed),
        broker: this.broker,
        registerDeferral: (body) => this.core.deferPermission(this.instanceId ?? "", body),
        instanceId: this.instanceId ?? "",
        redeemCapabilityToken: async (target) => {
          const deadlineAtMs = Date.now() + Math.max(0, Date.parse(target.expiresAt) - this.clock.coreNow());
          return this.core.redeemCapabilityToken(this.instanceId ?? "", { assignmentId: target.id, attempt: target.attempt, mcpCapabilityTokenRef: target.agentRoute.mcpCapabilityTokenRef ?? "" }, deadlineAtMs);
        },
        browserToolUrl: this.native ? null : this.config.SUPERVISOR_BROWSER_TOOL_URL,
        workspaceRoot: this.native ? this.options.native!.runners.find(config => config.RUNNER_AGENT_ID === runner.agentId)!.RUNNER_WORKSPACE_DIR : "/workspace",
        ...(this.native ? {
          deploymentKind: "native_connector" as const,
          executionAuthority: { client: this.core, runnerIncarnation: this.runnerIncarnation },
          registerReady: createNativeReadyRegistrar({
            clock: this.clock, journal: this.journal, client: this.core,
            instanceId: this.instanceId ?? "", workspaceId: this.workspaceId ?? "", runnerIncarnation: this.runnerIncarnation,
            assertActive: () => {
              if (this.stopping || !this.nativeOwnership || this.lease.mode() !== "active") throw new RemoteInstanceError("capability_unavailable", "Native readiness requires an active owned instance.");
              this.nativeOwnership.assertOwned();
            },
          }),
          prepareInputs: this.options.native!.prepareInputs ?? createNativeInputPreparer({
            logger: this.logger,
            root: this.options.native!.runners.find(config => config.RUNNER_AGENT_ID === runner.agentId)!.RUNNER_WORKSPACE_DIR,
            clock: this.clock,
            mutate: this.stateMutations!.run,
            ...(this.options.native!.git ? { git: this.options.native!.git } : {}),
            ...(this.options.native!.repositoryCacheRoot
              ? { repositoryCacheRoot: this.options.native!.repositoryCacheRoot }
              : {}),
            client: () => new NativeInputClient({
              baseUrl: this.config.SUPERVISOR_CORE_URL, roots: this.roots, clock: this.clock,
              credential: () => this.lease.mode() === "active" ? this.lease.current()?.lease ?? null : null,
            }),
            outputClient: () => new NativeOutputClient({
              baseUrl: this.config.SUPERVISOR_CORE_URL, clock: this.clock,
              credential: () => this.lease.mode() === "active" ? this.lease.current()?.lease ?? null : null,
            }),
            claimId: target => {
              if (this.stopping || !this.nativeOwnership || this.lease.mode() !== "active" || target.instanceId !== this.instanceId || target.workspaceId !== this.workspaceId) return null;
              this.nativeOwnership.assertOwned();
              const entry = this.journal.assignments.get(target.id + ":" + target.attempt);
              if (!entry || entry.workspaceId !== target.workspaceId || entry.placementId !== target.placementId || entry.kind !== target.kind || entry.agentId !== target.agentRoute.agentId ||
                  !["claimed", "running", "checkpointed"].includes(entry.state) || Date.parse(entry.expiresAt) <= this.clock.coreNow()) return null;
              return entry.claimId;
            },
          }),
        } : {}),
      }),
      onUsage: (observation) => this.sendUsageObservation(observation),
      gatewayBind: async (agentId, assignment) => { if (!this.native) await this.gateway.bindAssignment(agentId, { assignmentId: assignment.id, attempt: assignment.attempt, remainingOutputTokens: 1_000_000 }).catch(() => undefined); },
      gatewayRelease: async (agentId) => { if (!this.native) await this.gateway.releaseAssignment(agentId); },
    });
    if (this.native) this.cancellationReplay = new CancellationReplay({
      journal: this.journal,
      stopForRecovery: (assignmentId, attempt) => this.work.stopForRecovery(assignmentId, attempt),
      owner: () => {
        const ownership = this.nativeOwnership;
        const instanceId = this.instanceId;
        const workspaceId = this.workspaceId;
        const runnerIncarnation = this.runnerIncarnation;
        if (!ownership || !instanceId || !workspaceId || this.stopping) return null;
        return { instanceId, workspaceId, runnerIncarnation, assertCurrent: () => {
          if (this.stopping || this.nativeOwnership !== ownership || this.instanceId !== instanceId ||
              this.workspaceId !== workspaceId || this.runnerIncarnation !== runnerIncarnation) {
            throw new RemoteInstanceError("recovery_required", "Cancellation replay owner is not current");
          }
          ownership.assertOwned();
        } };
      },
    });
    this.planningTerminal = new PlanningTerminalDirectiveProcessor({
      clock: this.clock, journal: this.journal, reports: this.work.reports,
      instanceId: () => this.instanceId ?? "", runnerIncarnation: () => this.runnerIncarnation,
      assertOwned: () => {
        if (this.stopping || !this.nativeOwnership || !this.recoveryAuthority()) throw new RemoteInstanceError("recovery_required", "Native planning terminal owner is unavailable");
        this.nativeOwnership.assertOwned();
      },
      verify: (directive, tenantId, instanceId) => verifier.verifyPlanningTerminal(directive, tenantId, instanceId),
    });
    if (this.native) this.planningDirectivePoller = new ControllerDirectivePoller({
      core: this.core, journal: this.journal, processor: this.planningTerminal,
      instanceId: () => this.instanceId ?? "", runnerIncarnation: () => this.runnerIncarnation,
      canPoll: () => !this.stopping && this.recoveryAuthority() !== null, logger: this.logger,
    });
    this.reconciliation = new Reconciliation({
      clock: this.clock,
      journal: this.journal,
      core: this.core,
      instanceId: () => this.instanceId ?? "",
      runnerIncarnation: () => this.runnerIncarnation,
      assertOwned: () => {
        if (this.stopping) throw new RemoteInstanceError("temporarily_unavailable", "Supervisor is stopping.");
        if (this.native) {
          if (!this.nativeOwnership) throw new RemoteInstanceError("temporarily_unavailable", "Native state ownership is unavailable.");
          this.nativeOwnership.assertOwned();
        }
      },
      bundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
      protocolVersion: String(REMOTE_INSTANCE_PROTOCOL_VERSION),
      lastHeartbeatSequence: () => this.store.heartbeatSequence(),
      modelCapabilitySnapshots: () => this.modelCapabilities?.snapshots() ?? [],
      reserveHeartbeatFloor: floor => this.store.reserveHeartbeatFloor(floor),
      stopLocalWork: (assignmentId, attempt, assertCurrent) => this.work.stopForRecovery(assignmentId, attempt, assertCurrent),
      cancelAbsentLocalWork: (manifest, decision, assertCurrent) => this.work.cancelAbsentForRecovery(manifest, decision, assertCurrent),
      components,
      reports: this.work.reports,
      onLease: (lease, _expiresAt, assertCurrent) => this.adoptLease(lease, assertCurrent),
      afterEstablishment: async assertCurrent => {
        if (!this.native || this.activeLoopStarted) return;
        assertCurrent();
        const agents = this.inventory.agents();
        this.modelCapabilities?.invalidateForAgents(agents);
        await this.modelCapabilities?.refresh(agents);
        assertCurrent();
        if (this.ordinaryHeartbeatStarted) {
          // A startup retry may follow a completed publisher transition.
          // Reconciliation is pending again, so the normal utilization gate
          // remains closed while this publisher restores connectivity.
          await this.heartbeat.publish();
          assertCurrent();
          return;
        }
        await this.heartbeat.publishPending();
        assertCurrent();
        if (!this.pendingHeartbeatTimer) {
          this.pendingHeartbeatTimer = setInterval(() => {
            if (this.stopping || this.activeLoopStarted) return;
            void this.heartbeat.publishPending().catch(error => this.logger.warn({ err: error }, "pending recovery heartbeat failed"));
          }, (this.heartbeatIntervalSeconds ?? this.configuration.heartbeatIntervalSeconds) * 1000);
          this.pendingHeartbeatTimer.unref();
        }
      },
      captureLeaseFence: () => this.captureLeaseFence(),
      withLeaseAcquisition: operation => this.withLeaseAcquisition(operation),
    });

    if (applianceComponents) this.internal = await startInternalServer({
      port: this.config.SUPERVISOR_INTERNAL_PORT,
      componentSocketPath: this.config.SUPERVISOR_COMPONENT_SOCKET,
      component: {
        // Each component authenticates with the secret the supervisor provisioned for it.
        token: (kind) => (kind === "harness" ? harnessToken() : validationToken()),
        onComponentView: (_kind, view, draining) => { if (this.inventory instanceof InventoryCollector) this.inventory.updateComponent(view, draining); },
        onComponentStopped: async (kind, message) => {
          this.logger.info({ kind, reason: message.reason, interrupted: message.interruptedAssignmentIds.length, outboxFlushed: message.outboxFlushed }, "component stopped");
        },
        onReport: (report) => this.work.onComponentReport(report),
        onCheckpoint: (fact) => this.work.onComponentCheckpoint(fact),
        onDeferral: async (_kind, deferral) => {
          await this.core.deferPermission(this.instanceId ?? "", deferral);
        },
        onTaskCheckoutMaterialized: async (fact) => {
          await this.core.recordTaskCheckoutMaterialized(this.instanceId ?? "", fact.assignmentId, { taskId: fact.taskId, ...(fact.revision ? { revision: fact.revision } : {}) });
        },
        onUsage: (observation) => this.sendUsageObservation(observation),
        workSpec: async (assignmentId) => (await this.core.fetchWorkload(this.instanceId ?? "", assignmentId)).workload,
        // The Harness owns the checkout tree; it answers the read-only projection.
        resolveTaskCheckout: (input) =>
          applianceComponents.harness.taskCheckoutProjection({
            workspaceRef: input.workspaceRef,
            requestingAssignmentId: input.assignmentId,
            requestingAttempt: input.attempt,
            requestingWorkKind: "validation",
            requestingInstanceId: this.instanceId ?? "",
          }),
        redeemCapabilityToken: async (input) => {
          const issued = await this.core.redeemCapabilityToken(this.instanceId ?? "", { assignmentId: input.assignmentId, attempt: input.attempt, mcpCapabilityTokenRef: input.tokenRef });
          const authorization = issued.mcpServer.headers.find((header) => header.name.toLowerCase() === "authorization")?.value ?? "";
          return { token: authorization.replace(/^Bearer /, ""), platformMcpUrl: issued.mcpServer.url };
        },
        logger: this.logger,
      },
      key: () => this.key,
      onGatewayObservation: (observation, signature) => this.sendGatewayObservation(observation, signature),
      onComponentFact: async (fact) => {
        if (fact.kind === "terminal") await this.work.onComponentTerminal(fact);
        else if (fact.kind === "progress") await this.work.onComponentProgress(fact);
        else if (fact.kind === "checkpoint") await this.work.onComponentCheckpoint(fact);
      },
      onPreviewToCore: (channelId, chunk) => this.preview.onToCore(channelId, chunk),
      onForwarderStatus: (status) => this.preview.onForwarderStatus(status),
    });
    this.preview = new PreviewChannel({ transport: this.transport, lease: this.lease, sendToForwarder: (channelId, chunk) => this.internal?.sendPreview(channelId, chunk) ?? false, configureForwarder: (enabled, port) => this.internal?.configurePreview(enabled, port) });
    this.heartbeat = new HeartbeatPublisher({
      store: this.store,
      runnerIncarnation: () => this.runnerIncarnation,
      clock: this.clock,
      key: () => this.key,
      instanceId: () => this.instanceId ?? "",
      core: this.core,
      onResult: (result, assertCurrent) => this.adoptHeartbeat(result, assertCurrent),
      captureLeaseFence: () => this.captureLeaseFence(),
      withLeaseAcquisition: operation => this.withLeaseAcquisition(operation),
      onFailure: error => this.onHeartbeatFailure(error),
      inventory: this.inventory,
      onInventory: agents => {
        this.modelCapabilities?.invalidateForAgents(agents);
        void this.modelCapabilities?.refresh(agents).catch(error => this.logger.warn({ err: error }, "native model capability refresh failed"));
      },
      roleBindings: () => this.roleBindings,
      activeAssignmentIds: () => this.work.activeAssignmentIds(),
      modelCapabilitySnapshots: () => this.modelCapabilities?.snapshots() ?? [],
      configRevision: () => this.control.configRevision,
      bundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
      softMaxConcurrent: () => this.configuration.softMaxConcurrent ?? this.config.SUPERVISOR_SOFT_MAX_CONCURRENT,
      acceptingWork: () => !this.draining && this.lease.canPullNewWork() && this.reconciliation.isComplete,
      intervalSeconds: () => this.heartbeatIntervalSeconds ?? this.configuration.heartbeatIntervalSeconds,
      renewalDelayMs: () => this.lease.current() ? this.lease.nextRenewalDelayMs() : 5000,
    });

    for (const runner of this.runners.values()) runner.startEvents();
    const agents = await startNativeAgents({
      codexOwner: this.nativeCodexOwner,
      runners: this.nativeRunners,
      onUnavailable: (agentId, error) => this.logger.error({ err: error, agentId }, "agent could not start; the runtime continues without it"),
    });
    if (this.nativeCodexOwner && !agents.codexOwnerStarted) {
      // Codex is left out rather than taking every other agent down with it:
      // it is not advertised, so no work is placed on it.
      this.nativeCodexOwner = null;
      for (const runner of this.nativeRunners.filter(candidate => candidate.agentId === "codex")) this.runners.delete(runner.agentId);
      for (let index = this.nativeRunners.length - 1; index >= 0; index -= 1) {
        if (this.nativeRunners[index]!.agentId === "codex") this.nativeRunners.splice(index, 1);
      }
    }
    if (this.native) this.lastSnapshot = await this.inventory.collect();
    if (this.stopping) return;
    if (this.instanceId && this.administrativeStatus !== "provisioning") {
      await this.startActiveLoop();
    } else if (this.instanceId) {
      await this.continueProvisioning();
    } else {
      this.logger.warn("no instance identity yet; waiting for the launcher to run install");
    }
    this.muxTimer = setInterval(() => this.mux.tick(), 1_000);
    this.muxTimer.unref();
    if (this.cancellationReplay) {
      this.cancellationReplay.tick();
      this.cancellationTimer = setInterval(() => this.cancellationReplay?.tick(), 5_000);
      this.cancellationTimer.unref();
    }
  }

  private provisioningCredential: string | null = null;
  private provisioningLoopActive = false;

  /** Refresh is coalesced across provisioning, periodic polling and reconnect. */
  refreshConfiguration(): Promise<void> {
    if (this.stopping || !this.instanceId || !this.control) return Promise.resolve();
    this.configurationRefresh ??= (async () => {
      try {
        await this.configurationAcks.flush();
        if (this.stopping) return;
        const desired = await this.core.fetchDesiredConfiguration(this.instanceId!);
        if (!this.stopping) await this.control.handle(desired);
      } catch (error) {
        this.logger.warn({ err: error }, "configuration refresh failed; retaining last applied policy");
      }
    })().finally(() => { this.configurationRefresh = null; });
    return this.configurationRefresh;
  }

  /**
   * Core-bound channels are minted `<channel>:<instanceId>` so a relay
   * handshake knows whose endpoint cursor to ask (CP9 integration note).
   */
  private openCoreChannels(instanceId: string): void {
    for (const channel of CORE_BOUND_CHANNELS) this.mux.openChannel(coreChannelId(channel, instanceId), channel);
  }

  /**
   * Provisioning phase: keep the short credential fresh, wait for all four
   * components, submit readiness. Idempotent: the launcher may call
   * `readiness.submit` repeatedly while it waits, and only one loop runs.
   */
  private async continueProvisioning(): Promise<void> {
    const provisioning = await this.store.provisioning();
    if (!provisioning) return;
    if (this.provisioningLoopActive) return;
    this.provisioningLoopActive = true;
    this.provisioningCredential = provisioning.provisioningCredential;
    const tick = async (): Promise<void> => {
      const current = await this.store.provisioning();
      if (!current) return void (this.provisioningLoopActive = false);
      if (parseRfc3339(current.provisioningWindowExpiresAt) <= this.clock.coreNow()) {
        this.provisioningLoopActive = false;
        this.logger.error("provisioning window expired; a fresh activation is required");
        return;
      }
      if (provisioningCredentialIsExpired(current, this.clock)) {
        await refreshProvisioningCredential({ store: this.store, core: this.core, clock: this.clock, logger: this.logger }).catch((error: unknown) => this.logger.warn({ err: error }, "provisioning refresh failed"));
        this.provisioningCredential = (await this.store.provisioning())?.provisioningCredential ?? null;
      }
      const snapshot = await this.inventory.collect();
      this.lastSnapshot = snapshot;
      const unhealthy = snapshot.components.filter((component) => component.healthStatus !== "healthy");
      if (unhealthy.length > 0) {
        // Provisioning waits for all four components. Silence here reads as a
        // hung install, so name what is still missing on every attempt.
        this.logger.info({ waitingFor: unhealthy.map((component) => `${component.kind}:${component.healthStatus}`) }, "provisioning is waiting for components to become healthy");
        setTimeout(() => void tick(), 10_000).unref();
        return;
      }
      try {
        await this.refreshConfiguration();
        const result = await submitReadiness({
          store: this.store,
          core: this.core,
          clock: this.clock,
          protocolVersion: String(REMOTE_INSTANCE_PROTOCOL_VERSION),
          bundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
          components: snapshot.components.map((component) => ({ kind: component.kind, version: component.version, capabilities: component.capabilities, health: "healthy" as const })) as never,
          logger: this.logger,
        });
        this.provisioningCredential = null;
        this.administrativeStatus = "active";
        this.provisioningLoopActive = false;
        await this.adoptLease(result.lease);
        await this.startActiveLoop();
      } catch (error) {
        this.logger.warn({ err: error }, "readiness not yet accepted; retrying");
        // Core may have committed readiness and revoked the short credential
        // before its response reached us. Recover through the existing signed
        // owner/establishment/receipt protocol, never by reviving that bearer.
        // Core refuses recovery for identities still provisioning or revoked.
        if (this.native) {
          await this.startActiveLoop();
          if (this.activeLoopStarted) return;
        }
        setTimeout(() => void tick(), 15_000).unref();
      }
    };
    await tick();
  }

  private startActiveLoop(): Promise<void> {
    if (this.stopping || this.activeLoopStarted) return Promise.resolve();
    if (this.activeLoopStarting) return this.activeLoopStarting;
    this.startLivenessWatchdog();
    if (this.recoveryRetryTimer) clearTimeout(this.recoveryRetryTimer);
    this.recoveryRetryTimer = null;
    const operation = this.startActiveLoopImpl().catch(error => {
      this.logger.warn({ err: error }, "startup recovery remains pending");
      const record = this.journal.recovery.current(this.instanceId ?? "", this.runnerIncarnation);
      const terminal = record && record.state !== "pending" && record.state !== "applied";
      const denied = this.administrativeStatus === "revoked" || (error instanceof RemoteInstanceError && ["instance_revoked", "registration_mismatch", "reconciliation_replay", "resume_deadline_expired"].includes(error.code));
      if (!this.stopping && !this.activeLoopStarted && !terminal && !denied && !this.recoveryRetryTimer) {
        this.recoveryRetryTimer = setTimeout(() => { this.recoveryRetryTimer = null; void this.startActiveLoop(); }, 15_000);
        this.recoveryRetryTimer.unref();
      }
    }).finally(() => { this.activeLoopStarting = null; });
    this.activeLoopStarting = operation;
    return operation;
  }

  /** From the first recovery cycle on, some heartbeat (pending or ordinary) is
   * always due. When none has even been attempted for longer than the
   * publisher's budget, every loop is stuck behind one promise; say so with
   * the gates that are pending, then hand the process to its service manager. */
  private startLivenessWatchdog(): void {
    if (!this.native || this.livenessTimer) return;
    this.livenessWatchingSince = Date.now();
    this.livenessTimer = setInterval(() => {
      if (this.stopping || !this.livenessTimer) return;
      const budgetMs = Math.max(LIVENESS_MIN_BUDGET_MS, this.heartbeat.livenessBudgetMs());
      const liveness = this.heartbeat.liveness();
      const verdict = evaluateHeartbeatLiveness({ now: Date.now(), watchingSince: this.livenessWatchingSince ?? Date.now(), liveness, budgetMs });
      if (verdict.state === "live") { this.livenessQuietWarned = false; return; }
      const detail = { ...verdict, budgetMs, heartbeat: liveness, activeLoopStarted: this.activeLoopStarted, activeLoopStarting: this.activeLoopStarting !== null,
        recoveryRetryArmed: this.recoveryRetryTimer !== null, leaseMode: this.lease.mode(), administrativeStatus: this.administrativeStatus,
        activeResources: process.getActiveResourcesInfo().slice(0, 32) };
      if (verdict.state === "quiet") {
        if (!this.livenessQuietWarned) this.logger.warn(detail, "no heartbeat attempted for a while; the supervisor may be stuck");
        this.livenessQuietWarned = true;
        return;
      }
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
      this.logger.error(detail, "supervisor liveness lost: no heartbeat attempted within the budget; asking the service to restart");
      this.options.onLivenessLost?.(detail);
    }, LIVENESS_CHECK_MS);
    this.livenessTimer.unref();
  }

  private async startActiveLoopImpl(): Promise<void> {
    if (this.stopping) return;
    // Reload the managed-git binding before any onboard work can be claimed:
    // the key survives a restart, and a lane that forgot it would fall back to
    // the machine's ambient git on a host where only this key authenticates.
    await this.reloadManagedGitBinding();
    if (this.native) {
      try { await this.reconciliation.run(); }
      finally {
        this.stopPendingHeartbeat();
        await this.heartbeat.settle();
      }
      this.requireRecoveryAuthority();
      if (await this.store.provisioning()) {
        this.requireRecoveryAuthority();
        const identity = await this.store.identity();
        this.requireRecoveryAuthority();
        const status = this.administrativeStatus;
        if (!identity || identity.instanceId !== this.instanceId || (status !== "active" && status !== "draining" && status !== "suspended")) {
          throw new RemoteInstanceError("registration_mismatch", "Recovered provisioning identity is not authoritative.");
        }
        await this.store.saveIdentity({ ...identity, administrativeStatus: status });
        this.requireRecoveryAuthority();
        await this.store.clearProvisioning();
        this.provisioningCredential = null;
        this.provisioningLoopActive = false;
      }
    }
    if (this.instanceId) this.openCoreChannels(this.instanceId);
    await this.refreshConfiguration();
    if (this.stopping) return;
    if (this.native) this.requireRecoveryAuthority();
    if (!this.configurationTimer) {
      this.configurationTimer = setInterval(() => void this.refreshConfiguration(), 30_000);
      this.configurationTimer.unref();
    }
    if (!this.ordinaryHeartbeatStarted) {
      await this.heartbeat.start();
      this.ordinaryHeartbeatStarted = true;
    }
    if (this.stopping) return;
    if (this.native) this.requireRecoveryAuthority();
    this.activeLoopStarted = true;
    this.transport.start();
    this.planningDirectivePoller?.start();
    if (!this.native && !this.relay) await this.reconnectOverHttps();
    this.transport.resumeAfterRecovery();
    this.pullTimer = setInterval(() => this.work.pull(), 5_000);
    this.pullTimer.unref();
    if (this.native) {
      // bb: every 5 minutes release sessions idle for 30 minutes.
      this.reaperTimer = setInterval(() => void this.work.reapIdleCompletedSessions(IDLE_SESSION_RELEASE_MS).catch(() => undefined), IDLE_SESSION_SWEEP_MS);
      this.reaperTimer.unref();
      const update = this.options.native?.update;
      if (update && !this.updates) {
        this.updates = new NativeUpdateCoordinator({
          ...update,
          currentBundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
          trustedRoots: this.options.native!.trustedRoots,
          logger: this.logger,
          canApply: () => this.stopping ? { ok: false, reason: "supervisor is stopping" } : this.draining && this.drainReason !== "update" ? { ok: false, reason: `draining (${this.drainReason ?? "unknown"})` } : { ok: true },
        });
        this.updates.start();
      }
    }
    await this.work.reports.flushAll();
  }

  private async onRelayConnected(result: RelayRuntimeHandshakeResult): Promise<void> {
    // Reconnect completes before any channel other than control reopens.
    try {
      if (this.native) this.validateRelayHandshake(result);
      else await this.reconciliation.run();
      this.transport.resumeAfterRecovery();
      await this.work.reports.flushAll();
    } catch (error) {
      this.logger.warn({ err: error }, "reconciliation failed after relay connect; retrying on next handshake");
      this.relay?.rehandshake("reconciliation-failed");
    }
  }

  /**
   * The applied generation an outbound request originates from. Allocation
   * freezes this into the frame, so a later generation cannot relabel an old
   * request's origin; a process with no accepted generation may not send.
   */
  private acceptedManifestId(): string {
    const recovery = this.instanceId ? this.journal.recovery.current(this.instanceId, this.runnerIncarnation) : undefined;
    if (recovery?.state !== "applied" || !recovery.manifest || !recovery.acceptedAt) {
      throw new RemoteInstanceError("recovery_required", "Current process recovery is not durably accepted.");
    }
    return recovery.manifest.manifestId;
  }

  /** Local accepted-generation identity, not a substitute for Core authorization. */
  private recoveryAuthority(): string | null {
    if (this.stopping || !this.nativeOwnership || !this.instanceId || !this.lease.isValid() || this.lease.mode() === "none" || !this.reconciliation?.isComplete) return null;
    try { this.nativeOwnership.assertOwned(); } catch { return null; }
    const recovery = this.journal.recovery.current(this.instanceId, this.runnerIncarnation);
    if (recovery?.state !== "applied" || !recovery.manifest || !recovery.receipt || !recovery.acceptedAt) return null;
    return JSON.stringify([this.instanceId, this.runnerIncarnation, this.leaseAuthorityEpoch, recovery.manifest.ownerRevision, recovery.manifest.manifestId, recovery.receipt.digest, recovery.acceptedAt]);
  }

  private requireRecoveryAuthority(): void {
    if (!this.recoveryAuthority()) throw new RemoteInstanceError("recovery_required", "Current process recovery is not durably accepted.");
  }

  private validateRelayHandshake(result: RelayRuntimeHandshakeResult): void {
    if (!this.native) return;
    this.requireRecoveryAuthority();
    const current = this.journal.recovery.current(this.instanceId ?? "", this.runnerIncarnation)!;
    const remote = result.runtimeReconciliation;
    if (remote.state !== "confirmed" || remote.manifestId !== current.manifest?.manifestId || remote.receiptDigest !== current.receipt?.digest || remote.acceptedAt !== current.acceptedAt) {
      throw new RemoteInstanceError("recovery_required", "Relay did not confirm the current accepted recovery receipt.");
    }
  }

  private stopPendingHeartbeat(): void {
    if (this.pendingHeartbeatTimer) clearInterval(this.pendingHeartbeatTimer);
    this.pendingHeartbeatTimer = null;
  }

  private async reconnectOverHttps(): Promise<void> {
    try {
      await this.refreshConfiguration();
      await this.reconciliation.run();
    } catch (error) {
      this.logger.warn({ err: error }, "https reconciliation failed; will retry");
      setTimeout(() => void this.reconnectOverHttps(), 15_000).unref();
    }
  }

  // ── Lease ──────────────────────────────────────────────────────────────────

  private captureLeaseFence(): () => void {
    const epoch = this.leaseAuthorityEpoch;
    return () => {
      if (this.stopping || epoch !== this.leaseAuthorityEpoch) throw new RemoteInstanceError("temporarily_unavailable", "Lease response belongs to an invalidated lifecycle.");
      if (this.native) {
        if (!this.nativeOwnership) throw new RemoteInstanceError("temporarily_unavailable", "Native state ownership is unavailable.");
        this.nativeOwnership.assertOwned();
      }
    };
  }

  private mutateLease(operation: () => Promise<void>): Promise<void> {
    const pending = this.leaseMutation.then(operation);
    this.leaseMutation = pending.catch(() => undefined);
    return pending;
  }

  private withLeaseAcquisition<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.leaseAcquisition.then(() => {
      this.captureLeaseFence()();
      return operation();
    });
    this.leaseAcquisition = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async adoptLease(lease: string, assertCurrent = this.captureLeaseFence()): Promise<void> {
    assertCurrent();
    const claims = decodeLeaseClaims(lease, { instanceId: this.instanceId ?? "", audience: LEASE_AUDIENCE, deploymentKind: this.config.SUPERVISOR_DEPLOYMENT_KIND });
    if (this.native && claims.workspace_id !== this.workspaceId) throw new RemoteInstanceError("registration_mismatch", "lease workspace does not match the native activation");
    const record = leaseRecordFromClaims(lease, claims);
    await this.mutateLease(async () => {
      assertCurrent();
      const identity = await this.store.identity();
      assertCurrent();
      if (identity && identity.workspaceId !== claims.workspace_id) await this.store.saveIdentity({ ...identity, workspaceId: claims.workspace_id });
      assertCurrent();
      await this.store.saveLease(record);
      assertCurrent();
      this.lease.set(record);
      this.workspaceId = claims.workspace_id;
      if (claims.administrative_status) this.administrativeStatus = claims.administrative_status;
      this.leaseRestorationAllowed = record.mode === "active" && claims.administrative_status === "active";
      if (record.mode === "drain_only" && (!this.draining || this.drainReason === "limit_loss")) await this.beginDrain("limit_loss", record.drainDeadline);
      else this.restoreLeaseDrain();
    });
  }

  private async adoptHeartbeat(result: HeartbeatResult, assertCurrent: () => void): Promise<void> {
    if (this.stopping) return;
    const claims = decodeLeaseClaims(result.lease, { instanceId: this.instanceId ?? "", audience: LEASE_AUDIENCE, deploymentKind: this.config.SUPERVISOR_DEPLOYMENT_KIND });
    if (result.instanceId !== this.instanceId || result.leaseMode !== claims.lease_mode || parseRfc3339(result.leaseExpiresAt) !== claims.exp * 1000 ||
        (result.drainDeadline === undefined ? undefined : parseRfc3339(result.drainDeadline) / 1000) !== claims.drain_deadline) {
      throw new RemoteInstanceError("registration_mismatch", "Heartbeat lease metadata does not match its claims.");
    }
    if (claims.exp * 1000 <= this.clock.coreNow()) throw new RemoteInstanceError("temporarily_unavailable", "Heartbeat returned an expired lease.");
    await this.adoptLease(result.lease, assertCurrent);
    if (!this.stopping) this.heartbeatIntervalSeconds = result.heartbeatIntervalSeconds;
  }

  private async onHeartbeatFailure(error: unknown): Promise<void> {
    if (this.stopping) return;
    const code = error instanceof RemoteInstanceError ? error.code : "temporarily_unavailable";
    if (code === "instance_revoked" || code === "instance_suspended") {
      this.logger.error({ code }, "heartbeat renewal denied; stopping new work");
      this.administrativeStatus = code === "instance_revoked" ? "revoked" : "suspended";
      this.leaseAuthorityEpoch++;
      this.leaseRestorationAllowed = false;
      if (code === "instance_revoked") this.heartbeat.stop();
      this.lease.set(null);
      if (!this.draining) { this.draining = true; this.drainReason = "lease_lost"; }
      await this.mutateLease(() => this.store.clearLease());
      // Cancellation is tracked, but never awaited inside lease acquisition:
      // a stuck local tool cannot prevent suspended heartbeat retries. New
      // work stays drained until both cleanup and fresh Core authority agree.
      if (!this.leaseLossCleanup) {
        this.leaseLossCleanupFailed = false;
        this.leaseLossCleanup = Promise.resolve().then(() => this.work.drainSessions("lease_lost"))
          .catch(() => { this.leaseLossCleanupFailed = true; this.logger.error("lease-loss session cleanup failed; work remains drained"); })
          .finally(() => { this.leaseLossCleanup = null; this.restoreLeaseDrain(); });
      }
    }
  }

  private restoreLeaseDrain(): void {
    if (this.stopping || !this.leaseRestorationAllowed || !this.lease.isValid() || this.leaseLossCleanup || this.leaseLossCleanupFailed) return;
    if (this.drainReason !== "limit_loss" && this.drainReason !== "lease_lost") return;
    this.cancelDrainTimer();
    this.draining = false;
    this.drainReason = null;
  }

  // ── Inbound routing ────────────────────────────────────────────────────────

  private async onInbound(message: InboundMessage): Promise<void> {
    if (this.stopping) throw new RemoteInstanceError("temporarily_unavailable", "supervisor is stopping before durable receipt");
    switch (message.channel) {
      case "control": {
        const body = message.body as { type?: string; manifestId?: string };
        if (body.manifestId !== undefined) {
          await this.reconciliation.apply(message.body);
          return;
        }
        await this.control.handle(message.body);
        return;
      }
      case "assignment": {
        const terminal = PlanningControllerTerminalDirectiveSchema.safeParse(message.body);
        if (terminal.success) {
          const instanceId = this.instanceId ?? "", afterSequence = this.journal.planning.cursor(instanceId);
          await this.journal.planning.storePulled(instanceId, afterSequence, { version: 1, directives: [terminal.data], highWater: terminal.data.directiveSequence });
          await this.planningTerminal.accept(terminal.data);
          return;
        }
        await this.work.onAssignmentMessage(message.body, message.assignmentRequest);
        return;
      }
      case "session":
        await this.work.onSessionMessage(message.channelId, message.body);
        return;
      case "preview":
        this.preview.onToRuntime(message.channelId, message.body);
        return;
    }
  }

  private async onChannelReset(channelId: string): Promise<void> {
    const channel = channelOf(channelId);
    if (channel === "session") await this.work.onChannelReset(channelId);
    else if (channel === "preview") this.preview.closeChannel(channelId);
    else if (channel === "assignment" || channel === "observation") await this.work.reports.flushAll();
  }

  private async onRunnerEvent(agentId: string, event: Parameters<WorkOrchestrator["onRunnerEvent"]>[0]): Promise<void> {
    if (event.kind === "readiness_changed") {
      this.inventory.updateAgent(event.agent);
      const agents = this.inventory.agents();
      this.modelCapabilities?.invalidateForAgents(agents);
      void this.modelCapabilities?.refresh(agents).catch(error => this.logger.warn({ err: error }, "native model capability discovery failed"));
    }
    if (event.kind === "login_event") {
      const login = this.activeLogins.get(event.loginId);
      if (login) {
        const mapped = mapLoginEvent(event.loginId, event.event);
        login.emit(mapped);
        if (event.event.type === "completed" || event.event.type === "failed") {
          if (event.event.type === "completed") this.modelCapabilities?.invalidateAgent(agentId);
          this.activeLogins.delete(event.loginId);
        }
      }
    }
    if (event.kind === "agent_scope_reset") { this.modelCapabilities?.invalidateAgent(agentId); this.logger.info({ agentId, previousScope: event.previousScope }, "agent_scope_reset"); }
    if (event.kind === "agent_scope_attested") this.modelCapabilities?.invalidateAgent(agentId);
    await this.work.onRunnerEvent(event);
  }

  // ── Outbound facts ─────────────────────────────────────────────────────────

  private async sendControlAck(ack: ControlAck): Promise<void> {
    if (ack.type === "desired_configuration_ack") {
      await this.configurationAcks.submit(ack);
      return;
    }
    const key = `control:${"directiveId" in ack ? ack.directiveId : "rotationId" in ack ? ack.rotationId : `${ack.type}:${"revision" in ack ? ack.revision : ack.type === "version_ack" ? ack.bundleVersion : ack.acknowledgedAt}`}`;
    await this.outbox.enqueue({ id: randomUUID(), channel: "control", key, group: "control", order: this.clock.now(), body: ack, createdAt: this.clock.nowIso() });
    if (!this.stopping) {
      this.transport.send({ channel: "control", channelId: coreChannelId("control", this.instanceId ?? ""), body: ack, signature: "signature" in ack ? ack.signature : signBody(this.key, ack as unknown as { [key: string]: JsonValue }) });
    }
  }

  private async sendGatewayObservation(observation: GatewayCallObservation, signature: string): Promise<void> {
    await this.outbox.enqueue({ id: randomUUID(), channel: "observation", key: `gateway:${observation.assignmentId}:${observation.observedAt}:${observation.agentId}`, group: "observation", order: this.clock.now(), body: observation, createdAt: this.clock.nowIso() });
    this.transport.send({ channel: "observation", channelId: coreChannelId("observation", this.instanceId ?? ""), body: observation, signature });
  }

  private async sendUsageObservation(observation: AgentTurnUsageObservation): Promise<void> {
    await this.outbox.enqueue({ id: randomUUID(), channel: "observation", key: `usage:${observation.assignmentId}:${observation.observedAt}`, group: "observation", order: this.clock.now(), body: observation, createdAt: this.clock.nowIso() });
    this.transport.send({ channel: "observation", channelId: coreChannelId("observation", this.instanceId ?? ""), body: observation, signature: signBody(this.key, observation as unknown as { [key: string]: JsonValue }) });
  }

  // ── Drain / erase ──────────────────────────────────────────────────────────

  private async beginDrain(reason: string, deadline: string | null): Promise<number> {
    this.draining = true;
    this.drainReason = reason;
    this.drainDeadline = deadline;
    this.administrativeStatus = this.administrativeStatus === "active" ? "draining" : this.administrativeStatus;
    const active = this.work.activeCount();
    this.cancelDrainTimer();
    if (deadline) {
      const epoch = this.drainEpoch;
      const expire = () => {
        if (this.stopping || !this.draining || epoch !== this.drainEpoch) return;
        const remaining = parseRfc3339(deadline) - this.clock.coreNow();
        if (remaining > 0) {
          this.drainTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
          this.drainTimer.unref();
        } else {
          this.drainTimer = null;
          void this.work.drainSessions("drain").catch(() => this.logger.error("drain deadline session cleanup failed"));
        }
      };
      expire();
    }
    this.logger.info({ reason, active }, "draining: no new claims");
    return active;
  }

  private cancelDrainTimer(): void {
    this.drainEpoch++;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  private async eraseAssignments(assignmentIds: string[]): Promise<{ failed: string[]; reason?: "data_in_use" | "local_io_failure" | "unsupported_scope" }> {
    const failed: string[] = [];
    for (const assignmentId of assignmentIds) {
      const active = this.journal.activeAssignments().some((entry) => entry.assignmentId === assignmentId);
      if (active) {
        failed.push(assignmentId);
        continue;
      }
      for (const entry of this.journal.assignments.all().filter((candidate) => candidate.assignmentId === assignmentId)) {
        await this.journal.assignments.remove(`${entry.assignmentId}:${entry.attempt}`);
      }
      await this.journal.planning.removeAssignment(assignmentId);
    }
    return failed.length > 0 ? { failed, reason: "data_in_use" } : { failed };
  }

  private async eraseAll(): Promise<{ ok: boolean; reason?: "data_in_use" | "local_io_failure" | "unsupported_scope" }> {
    if (this.work.activeCount() > 0) return { ok: false, reason: "data_in_use" };
    try {
      await this.work.drainSessions("drain");
      await this.journal.assignments.clear();
      await this.journal.pendingRequests.clear();
      await this.journal.planning.clear();
      await this.outbox.clear();
      // Agent credential volumes are never touched by an erase directive; only `uninstall --purge` removes them.
      return { ok: true };
    } catch {
      return { ok: false, reason: "local_io_failure" };
    }
  }

  private headroom(): number {
    const ceiling = this.configuration.softMaxConcurrent ?? this.config.SUPERVISOR_SOFT_MAX_CONCURRENT ?? Number.POSITIVE_INFINITY;
    const active = this.work.activeCount();
    const readyAgents = this.lastSnapshot?.agents.filter((agent) => agent.readiness === "ready").length ?? 0;
    if (readyAgents === 0) return 0;
    return Math.max(0, Math.min(ceiling, readyAgents * 4) - active);
  }

  /** Redeem the claim's capability token into the platform MCP entry. In memory and in the dispatch body only; never journaled. */
  private async redeemPlatformMcp(assignment: RemoteWorkAssignment): Promise<PlatformMcpEntry | undefined> {
    const ref = assignment.agentRoute.mcpCapabilityTokenRef;
    if (!ref) return undefined;
    // Bounded by the assignment's own expiry, so a redemption cannot outlive
    // the work it was for. Shared by the ACP lane and the onboard facade.
    const deadlineAtMs = Date.now() + Math.max(0, Date.parse(assignment.expiresAt) - this.clock.coreNow());
    const issued = await this.core.redeemCapabilityToken(this.instanceId ?? "", { assignmentId: assignment.id, attempt: assignment.attempt, mcpCapabilityTokenRef: ref }, deadlineAtMs);
    return issued.mcpServer;
  }

  /**
   * The onboard lane, composed once. Everything it needs is local: the
   * machine's own git, a scratch directory, and the capability token the
   * orchestrator redeems per claim. No connector credential and no broker
   * client appear here, and none may (invariant 3, A5).
   */
  private onboardCarrier(): OnboardWorkCarrier {
    const scratch = new OnboardScratch(this.config.SUPERVISOR_ONBOARD_SCRATCH_ROOT);
    const resolveRemote = createRemoteResolver(() => this.managedGitBinding);
    return new OnboardWorkCarrier({
      collector: {
        git: this.git,
        rawFiles: new RawFileApi({ git: this.git }),
        scratch,
        resolveRemote,
        concurrency: this.config.SUPERVISOR_ONBOARD_MAX_CONCURRENT,
      },
      relocation: {
        git: this.git,
        scratch,
        managedBinding: () => this.managedGitBinding,
        now: () => this.clock.nowIso(),
      },
      redeemFacade: assignment => this.redeemPlatformMcp(assignment),
      fetchWorkload: (assignment: OnboardWorkAssignment) => this.core.fetchWorkload(this.instanceId ?? "", assignment.id),
    });
  }

  /** Re-read the registered key, if any. An unregistered runtime is normal. */
  private async reloadManagedGitBinding(): Promise<void> {
    if (!this.instanceId) return;
    try { this.managedGitBinding = await this.gitKeys().binding(); }
    catch (error) { this.logger.debug({ err: error }, "no managed git key is registered on this runtime"); }
  }

  /** The key store; the private half never leaves the directory it names. */
  private gitKeys(): GitKeyStore {
    const instanceId = this.instanceId;
    if (!instanceId) throw new RemoteInstanceError("temporarily_unavailable", "This runtime is not activated yet; register a key after installation completes.");
    return new GitKeyStore({
      directory: this.config.SUPERVISOR_ONBOARD_GIT_KEY_DIR,
      registrar: {
        register: body => this.core.registerGitKey(instanceId, body),
        list: () => this.core.listGitKeys(instanceId),
        revoke: keyRef => this.core.revokeGitKey(instanceId, keyRef),
      },
    });
  }

  /** The non-agent facts a role may depend on; one source for every reader. */
  private roleCapabilityInputs(): RoleCapabilityInputs {
    return { browserToolAvailable: this.lastSnapshot?.browserToolAvailable ?? false, gitVersion: this.lastSnapshot?.gitVersion ?? null };
  }

  // ── Status and control socket ─────────────────────────────────────────────

  status(): SupervisorStatus {
    const relay = this.relay?.status();
    const lease = this.lease.current();
    return {
      instanceId: this.instanceId,
      workspaceId: this.workspaceId,
      administrativeStatus: this.administrativeStatus,
      connectivity: { transport: relay?.state === "connected" ? "relay" : this.transport?.available ? "https_fallback" : "offline", relayConnected: relay?.state === "connected", lastConnectedAt: relay?.lastConnectedAt ?? null, reconciliationComplete: this.reconciliation?.isComplete ?? false },
      lease: { mode: this.lease.mode(), expiresAt: lease?.expiresAt ?? null, drainDeadline: lease?.drainDeadline ?? null },
      version: { bundle: this.config.SUPERVISOR_BUNDLE_VERSION, protocol: String(REMOTE_INSTANCE_PROTOCOL_VERSION), manifestDigest: this.manifestDigest || null, updateAvailable: this.control?.versionPolicy?.updateAvailable ?? false, targetBundle: this.control?.versionPolicy?.targetBundle ?? null },
      configRevision: this.control?.configRevision ?? 0,
      components: (this.lastSnapshot?.components ?? []).map((component) => ({ kind: component.kind, version: component.version, healthStatus: component.healthStatus, capabilities: component.capabilities, lastProbeAt: component.lastProbeAt })),
      roles: (this.heartbeat?.roles() ?? []) as SupervisorStatus["roles"],
      roleBindings: this.roleBindings,
      utilization: { acceptingWork: !this.draining && this.lease.canPullNewWork(), activeSessions: this.lastSnapshot?.activeSessions ?? 0, activeTurns: this.lastSnapshot?.activeTurns ?? 0, utilizationRatio: Math.min(1, this.lastSnapshot?.hostPressure ?? 0), ...(this.configuration.softMaxConcurrent === undefined ? {} : { softMaxConcurrent: this.configuration.softMaxConcurrent }) },
      previewEnabled: this.preview?.exposure().enabled ?? false,
      previewExposure: this.preview?.exposure().enabled ? { port: this.preview.exposure().port ?? 0, grantPresent: this.preview.exposure().grantPresent } : null,
      pendingErase: this.journal.erase.all().filter((record) => !record.receiptSent).length,
      pendingRevocation: this.pendingRevocation,
      journal: { assignments: this.journal.activeAssignments().length, outboxDepth: this.outbox.depth, recoveryRequired: this.journal.recoveryRequired().length },
    };
  }

  controlHandler(): ControlHandler {
    return async (request, emit) => {
      switch (request.op) {
        case "status":
          return this.status();
        case "agents":
          return { agents: this.lastSnapshot?.agents ?? this.inventory.agents(), roles: this.heartbeat?.roles() ?? [], roleBindings: this.roleBindings };
        case "auth.status":
          return { agents: (this.lastSnapshot?.agents ?? this.inventory.agents()).filter((agent) => request.agentId === undefined || agent.agentId === request.agentId) };
        case "auth.login": {
          const runner = this.requireRunner(request.agentId);
          const loginId = `login-${randomUUID()}`;
          this.activeLogins.set(loginId, { agentId: request.agentId, emit: (event) => emit.event(event) });
          await runner.login(request.organization, loginId);
          emit.event({ kind: "started", loginId, agentId: request.agentId });
          return { loginId };
        }
        case "auth.input": {
          const login = this.activeLogins.get(request.loginId);
          if (!login) throw new RemoteInstanceError("temporarily_unavailable", "no login in progress with that id");
          await this.requireRunner(login.agentId).loginInput(request.loginId, request.text);
          return {};
        }
        case "auth.cancel": {
          const login = this.activeLogins.get(request.loginId);
          if (!login) return {};
          await this.requireRunner(login.agentId).loginCancel(request.loginId);
          this.activeLogins.delete(request.loginId);
          return {};
        }
        case "auth.logout":
          return this.requireRunner(request.agentId).logout();
        case "gateway.key.set":
          if (this.native) throw new RemoteInstanceError("capability_unavailable", "BYOK is not supported by a native connector.");
          await this.gateway.setKey(request.agentId, request.key);
          return { agentId: request.agentId, keyed: true };
        case "gateway.key.clear":
          if (this.native) throw new RemoteInstanceError("capability_unavailable", "BYOK is not supported by a native connector.");
          await this.gateway.clearKey(request.agentId);
          return { agentId: request.agentId, keyed: false };
        case "git.key.add": {
          const store = this.gitKeys();
          const key = await store.add(request.title ?? `konteks-remote ${this.instanceId ?? "runtime"}`);
          this.managedGitBinding = await store.binding();
          // The reference, the fingerprint and the host; never the key.
          // The key file's PATH lets the person's own git use the key for the
          // repository onboarding pushes (WS1-021); the key itself never leaves.
          return {
            keyRef: key.keyRef, title: key.title, fingerprint: key.fingerprint, host: key.host,
            sshConfig: sshConfigPath(this.config.SUPERVISOR_ONBOARD_GIT_KEY_DIR),
            // The key file, wherever the person's push needs it: the binding
            // exists only when the registration named a host (WS1-026).
            identityFile: store.privateKeyPath,
            user: this.managedGitBinding?.user ?? "git",
          };
        }
        case "git.key.list":
          return { keys: await this.gitKeys().list() };
        case "git.key.remove": {
          const store = this.gitKeys();
          await store.remove(request.keyRef);
          this.managedGitBinding = await store.binding();
          return { keyRef: request.keyRef, revoked: true };
        }
        case "preview.enable":
          if (this.native) throw new RemoteInstanceError("capability_unavailable", "Native preview forwarding has not been configured.");
          this.preview.enable(request.port);
          return this.preview.exposure();
        case "preview.disable":
          this.preview.disable();
          return this.preview.exposure();
        case "drain":
          return { activeAssignments: await this.beginDrain(request.reason, null) };
        case "drain.status":
          return { draining: this.draining, reason: this.drainReason, activeAssignments: this.work.activeCount(), openSessions: this.work.openSessions() };
        case "drain.cancel": {
          // Only a locally requested drain is reversible; a Core directive with a
          // deadline stays in force until Core lifts it.
          if (this.draining && this.drainDeadline === null) {
            this.draining = false;
            this.drainReason = null;
            if (this.administrativeStatus === "draining") this.administrativeStatus = "active";
            this.logger.info("drain cancelled by the local operator");
          }
          return { draining: this.draining, reason: this.drainReason, activeAssignments: this.work.activeCount(), openSessions: this.work.openSessions() };
        }
        case "update.check":
          return this.requireUpdates().check();
        case "update.apply":
          return this.requireUpdates().apply("operator");
        case "update.status":
          return this.requireUpdates().status();
        case "doctor":
          return this.doctor();
        case "logs":
          return { lines: this.logLines.slice(-2_000) };
        case "support.bundle": {
          const doctor = await this.doctor();
          return buildSupportBundle({
            bundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
            protocolVersion: String(REMOTE_INSTANCE_PROTOCOL_VERSION),
            instanceId: this.instanceId,
            administrativeStatus: this.administrativeStatus,
            doctor,
            configurationKeys: flattenKeys(this.configuration),
            counters: { relay: { ...this.mux.counters }, control: { ...this.control.counters }, work: { ...this.work.counters }, preview: { ...this.preview.counters } },
            recentLogLines: this.logLines,
            generatedAt: this.clock.nowIso(),
          }).document;
        }
        case "readiness.submit":
          await this.continueProvisioning();
          return this.status();
        case "revoke.pending":
          this.pendingRevocation = true;
          return { pendingRevocation: true };
        case "instance.retire": {
          if (!this.instanceId) throw new RemoteInstanceError("temporarily_unavailable", "This runtime is not activated, so there is nothing to remove from Konteks.");
          const result = await this.core.retire(this.instanceId);
          if (result.outcome !== "draining") {
            // Removed from its workspace, a runtime has nothing left to do:
            // it stops once this answer is sent, so uninstall never deletes a
            // folder out from under a process still running in it.
            this.administrativeStatus = "removed";
            setTimeout(() => { void this.stop().catch(() => undefined); }, 500).unref?.();
          }
          return result;
        }
      }
    };
  }

  private requireUpdates(): NativeUpdateCoordinator {
    if (!this.updates) throw new RemoteInstanceError("capability_unavailable", "Automatic updates are not configured for this connector.");
    return this.updates;
  }

  private requireRunner(agentId: string): RunnerPort {
    const runner = this.runners.get(agentId);
    if (!runner) throw new RemoteInstanceError("agent_unavailable", `no runner for agent ${agentId}`, { recoveryActions: [{ kind: "run_doctor" }] });
    return runner;
  }

  private async doctor() {
    const gateway = this.native ? null : await this.gateway.health();
    const snapshot = this.lastSnapshot ?? (await this.inventory.collect());
    return runDoctor({
      deploymentKind: this.config.SUPERVISOR_DEPLOYMENT_KIND,
      now: () => this.clock.nowIso(),
      dataDir: this.config.SUPERVISOR_DATA_DIR,
      identity: { instanceId: this.instanceId, administrativeStatus: this.administrativeStatus },
      lease: { mode: this.lease.mode(), expiresAt: this.lease.current()?.expiresAt ?? null },
      relay: this.relay?.status() ?? { state: "offline", lastError: "relay not configured", consecutiveFailures: 0 },
      transport: this.transport.kind,
      reconciliationComplete: this.reconciliation.isComplete,
      components: snapshot.components,
      agents: snapshot.agents,
      gateway,
      configRevision: this.control.configRevision,
      expectedAllowlistRevision: this.release?.egressAllowlist.revision ?? "",
      diskFreeBytes: snapshot.diskFreeBytes,
      minimumDiskBytes: this.release?.minimums.diskBytes ?? 0,
      preview: this.preview.exposure(),
      outboxDepth: this.outbox.depth,
      recoveryRequired: this.journal.recoveryRequired().length,
      coreSignatureConfigured: this.roots.some((root) => (root.coreControlKeys ?? []).length > 0),
    });
  }

  stop(): Promise<void> {
    this.leaseAuthorityEpoch++;
    this.stopping = true;
    // Before anything that can outlast the daemon's exit watchdog (WS1-042).
    this.nativeCodexOwner?.shutdownRequested();
    this.draining = true;
    this.heartbeat?.stop();
    this.stopPendingHeartbeat();
    if (this.recoveryRetryTimer) clearTimeout(this.recoveryRetryTimer);
    this.recoveryRetryTimer = null;
    this.cancelDrainTimer();
    this.stopPromise ??= this.stopImpl();
    return this.stopPromise;
  }

  private async stopImpl(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    await this.activeLoopStarting;
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.updates?.stop();
    if (this.muxTimer) clearInterval(this.muxTimer);
    if (this.cancellationTimer) clearInterval(this.cancellationTimer);
    await this.cancellationReplay?.stop();
    if (this.configurationTimer) clearInterval(this.configurationTimer);
    await this.configurationRefresh;
    await this.configurationAcks?.settle();
    await this.planningDirectivePoller?.stop();
    this.heartbeat?.stop();
    await this.heartbeat?.settle();
    await this.leaseAcquisition;
    await this.leaseMutation;
    await this.leaseLossCleanup;
    await this.work?.drainSessions("drain");
    for (const runner of this.nativeRunners) await runner.stop();
    await this.nativeCodexOwner?.stop();
    for (const runner of this.runners.values()) runner.stopEvents();
    this.transport?.stop();
    await this.internal?.close().catch(() => undefined);
    await this.stateMutations?.close();
    this.nativeOwnership?.release();
  }
}

const channelOf = channelOfId;

function flattenKeys(value: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) keys.push(...flattenKeys(entry as Record<string, unknown>, full));
    else keys.push(full);
  }
  return keys;
}

function mapLoginEvent(loginId: string, event: { type: string; text?: string | undefined; url?: string | undefined; userCode?: string | undefined; label?: string | undefined; secret?: boolean | undefined; readiness?: string | undefined; code?: string | undefined; message?: string | undefined }): ControlLoginEvent {
  switch (event.type) {
    case "display":
      return { kind: "display", loginId, text: event.text ?? "" };
    case "open_url":
      return { kind: "open_url", loginId, url: event.url ?? "", ...(event.userCode ? { userCode: event.userCode } : {}) };
    case "prompt":
      return { kind: "prompt", loginId, label: event.label ?? "", secret: event.secret ?? true };
    case "completed":
      return { kind: "completed", loginId, readiness: event.readiness ?? "unknown" };
    default:
      return { kind: "failed", loginId, code: event.code ?? "agent_auth_required", message: event.message ?? "login failed" };
  }
}
