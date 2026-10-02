import { ObservationDelivery } from "./control/observation-delivery.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  REMOTE_INSTANCE_PROTOCOL_VERSION,
  PlanningControllerTerminalDirectiveSchema,
  RemoteInstanceError,
  CoreResponseError,
  AgentLoginGcpSchema,
  AgentLoginOptionIdSchema,
  ON_COMPUTER_LOGIN_OPTION,
  REMOTE_AGENT_LOGIN_ON_COMPUTER_CAPABILITY,
  SystemClock,
  createLogger,
  parseRfc3339,
  signBody,
  type AgentTurnUsageObservation,
  type ControlAck,
  type ControlHandler,
  type ControlLoginEvent,
  type ConnectedAgentView,
  type ConnectorCommandsManifest,
  type HeartbeatResult,
  type InstanceKeyPair,
  type JsonValue,
  type Logger,
  type RemoteWorkAssignment,
  type RelayRuntimeHandshakeResult,
  type SupervisorStatus,
  type PreviewStatusReport,
  type RuntimeAgentLoginDeliveryRequest,
  coreContractAtLeast,
} from "@konteks/remote-common";
import { EmbeddedReleaseRootSchema, NATIVE_MANIFEST_URL, isHostAgentId, nativeManifestUrl, connectorCommandsManifest, selectNativeModelCapabilityMappings, verifyNativeRelease, type VerifiedNativeRelease, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { chromeInstalled, readAntigravityAdminObservation, type RunnerConfig } from "@konteks/remote-agent-runner";
import type { NativeRuntimeRecord, NativeUnavailableAgent } from "./native/installation.js";
import { SignalSampler } from "@konteks/remote-sysmon";
import { loadSupervisorConfig, type SupervisorConfig } from "./config.js";
import { CoreClient, LEASE_AUDIENCE } from "./core/client.js";
import { CoreSignatureVerifier } from "./control/core-signature.js";
import { CancellationReceiver } from "./control/cancellation-receiver.js";
import { ExecutionRevisionControlReceiver } from "./control/execution-revision-control-receiver.js";
import { ExecutionRevisionFenceReceiptDelivery } from "./control/execution-revision-fence-receipt-delivery.js";
import { DiagnosticCompanionReceiver } from "./control/diagnostic-companion-receiver.js";
import { diagnosticCompanionOperationalObservation } from "./control/diagnostic-companion-observability.js";
import { PermissionAnswerReceiver } from "./control/permission-answer-receiver.js";
import { CancellationReplay } from "./control/cancellation-replay.js";
import { ControlHandlers, compareSemver } from "./control/handlers.js";
import { ConfigurationAckDelivery } from "./control/configuration-ack-delivery.js";
import { HeartbeatPublisher } from "./heartbeat/heartbeat.js";
import type { InventorySnapshot } from "./inventory/snapshot.js";
import { deriveAdvertisedRoles, type RoleBinding, type RoleCapabilityInputs } from "./inventory/roles.js";
import { LocalGit, OnboardScratch } from "./onboard/git.js";
import { GitKeyStore, sshConfigPath } from "./onboard/git-keys.js";
import { RawFileApi } from "./onboard/raw-file-api.js";
import { createRemoteResolver, type ManagedGitBinding } from "./onboard/remotes.js";
import { OnboardWorkCarrier, type OnboardWorkAssignment } from "./onboard/carrier.js";
import type { PlatformMcpEntry } from "./work/workload.js";
import { acceptedWorkKinds } from "./work/accepted-kinds.js";
import { integrationTaskCapabilities, type IntegrationWorkCarrier } from "./integration/carrier.js";
import { composeIntegrationCarrier } from "./integration/compose.js";
import { LeaseState, decodeLeaseClaims, decodeStoredLeaseClaims, leaseRecordFromClaims } from "./lease/lease.js";
import { channelOfId, coreChannelId, CORE_BOUND_CHANNELS } from "./relay/channel-ids.js";
import { PreviewWorktreePermits } from "./preview/worktree-permits.js";
import { PreviewChannel } from "./preview/preview-channel.js";
import { PreviewProcessManager, PreviewProcessRegistry } from "./preview/process-manager.js";
import type { SessionPreviewAccess } from "./preview/mcp-server.js";
import { provisioningCredentialIsExpired, refreshProvisioningCredential, submitReadiness } from "./provisioning/activation.js";
import { Reconciliation } from "./reconnect/reconciliation.js";
import { ChannelMux } from "./relay/channel-mux.js";
import { RelayClient } from "./relay/relay-client.js";
import type { RunnerPort } from "./runner-port.js";
import { NativeRunner, type NativeRunnerOptions } from "./native/runner.js";
import { ModelCapabilitySnapshotProducer, antigravityOptionBilling, openCodeOptionBilling } from "./native/model-capability-snapshot.js";
import { NativeInventoryCollector, machineHasDesktop } from "./native/inventory.js";
import { windowsInstalledLauncher } from "./native/windows-launcher.js";
import { antigravityRunnerCapabilities, openCodeRunnerCapabilities, siteLoginRelay } from "./native/site-login.js";
import { ON_COMPUTER_AGENTS, canOpenOnComputer, onComputerDone, onComputerScript, openOnComputer, planOnComputer, readOnComputerWatches, releaseLauncher, removeOnComputerWatch, standInTerminalEnv, writeOnComputerWatch, type OnComputerAgent, type OnComputerWatch } from "./native/on-computer.js";
import { antigravityDownloadState, withAntigravityDownload } from "./native/antigravity-download.js";
import { antigravityDiskBytes, antigravityPin } from "./native/antigravity-installation.js";
import { BROWSER_TOOL_CAPABILITY, resolveConnectorBrowser, withConnectorBrowser, type ConnectorBrowserStatus } from "./native/browser-capability.js";
import { NativeInputClient } from "./native/input-client.js";
import { NativeOutputClient } from "./native/output-client.js";
import { createRetainedDeliveryOutputRecovery } from "./native/output-recovery.js";
import { createNativeInputPreparer } from "./native/input-preparer.js";
import { createNativeReadyRegistrar } from "./native/execution-ready.js";
import type { NativeGitTool } from "./native/git-workspace.js";
import { verifyInstalledNativeBridges } from "./native/installed.js";
import { acquireNativeRootLock, type NativeRootLock } from "./native/root-lock.js";
import { NativeCodexAppServerOwner, type NativeCodexAppServerOwnerOptions } from "./native/codex-app-server-owner.js";
import { NativeAgentRetry, startNativeAgents } from "./native/start-native-agents.js";
import { NotAddedAgentsDetector, SUPPORTED_AGENT_IDS, projectSupportedAgents, type AddedAgentFacts } from "./native/supported-agents.js";
import { StateMutationGate } from "./state/mutation-gate.js";
import type { RelayedSessionDeps } from "./session/relayed-session.js";
import { PermissionBroker } from "./session/permissions.js";
import { EvaluatorPolicyResponder } from "./session/policy-responder.js";
import { createWorkspaceToolPolicy } from "./session/workspace-tool-policy.js";
import { ClaudeExecutableIdentity } from "./native/claude-executable-identity.js";
import { SupervisorJournal } from "./state/journal.js";
import { DurableOutbox } from "./state/outbox.js";
import { DEFAULT_CONFIG, MACHINE_KEY_LOST, SupervisorStore, type ConfigRecord, type ShutdownProgress } from "./state/store.js";
import { buildSupportBundle } from "./support/bundle.js";
import { runDoctor, type AntigravityDoctorInputs, type OpenCodeDoctorInputs } from "./support/doctor.js";
import { openCodeInstallKind } from "./native/opencode-installation.js";
import { HttpsFallbackTransport } from "./transport/https-fallback.js";
import { RecoveryAuthority } from "./transport/recovery-authority.js";
import { AssignmentSender } from "./work/assignment-sender.js";
import { RelayTransport, TransportManager } from "./transport/relay-transport.js";
import type { InboundMessage } from "./transport/transport.js";
import { WorkOrchestrator } from "./work/orchestrator.js";
import { PlanningTerminalDirectiveProcessor } from "./work/planning-terminal-directives.js";
import { ControllerDirectivePoller } from "./work/controller-directive-poller.js";
import { DurableSearchAssignmentCarrier } from "./work/search-assignment-carrier.js";
import { NativeUpdateCoordinator, type NativeUpdateCoordinatorOptions } from "./native/update.js";
import type { NativeUpdateLedger } from "./native/update-ledger.js";
import { evaluateHeartbeatLiveness, isCredentialRefusal, leaseLapseNeedsRestart } from "./heartbeat/liveness.js";

/**
 * The composition root: wires state, transport, heartbeat, control, work,
 * sessions, and the loopback control socket into one supervisor.
 */

/** How long preview_start waits for the dev server before answering "still starting". */
const PREVIEW_START_WAIT_MS = 45_000;
/** A viewer's page refreshes every few seconds; a preview that failed is not retried faster than this. */
const PREVIEW_VIEWER_RETRY_MS = 60_000;

/** bb releases sessions idle for 30 minutes, checked every 5 minutes. */
const IDLE_SESSION_RELEASE_MS = 30 * 60_000;
const IDLE_SESSION_SWEEP_MS = 5 * 60_000;
const LIVENESS_CHECK_MS = 30_000;
/** How long a site-started step waits on the person at the window on this computer (Core keeps it 30 minutes). */
const ON_COMPUTER_WATCH_MS = 30 * 60_000;
/** How often the connector looks whether that step's agent reads ready. */
const ON_COMPUTER_POLL_MS = 5_000;
/** A turn's start or end is told to Core this soon, not at the next 30 s heartbeat (WS1-179). */
const TURN_ACTIVITY_HEARTBEAT_MS = 500;
const LIVENESS_MIN_BUDGET_MS = 5 * 60_000;
/**
 * How long Core may keep refusing this runtime's lapsed lease (Core answers,
 * the lease is gone) before the service restarts into its startup reconnect,
 * which proves the machine key and gets a fresh lease. Nothing renewed a lapsed
 * lease in a running process (RCA 2026-09-30: offline 13 h, then 6 h).
 */
const LEASE_LAPSE_RESTART_MS = 2 * 60_000;
/** How often a runtime Core refuses as too old re-reads the release channel. */
const REFUSED_BUNDLE_UPDATE_INTERVAL_MS = 10 * 60_000;

export interface SupervisorOptions {
  /** Native only: called once when no heartbeat has been attempted for longer
   * than the publisher's budget. The service wires it to a non-zero shutdown so
   * the service manager replaces a silent process. */
  onLivenessLost?: (detail: Record<string, unknown>) => void;
  /** This runtime was removed from its workspace (uninstall): end the whole process, not only the supervisor. */
  onRetired?: () => void;
  /** A local `shutdown` request: end the process the way a signal would. */
  onShutdownRequested?: () => void;
  native?: {
    /** Public trust provided by the verified native executable, never by writable install metadata. */
    trustedRoots: readonly EmbeddedReleaseRoot[];
    runners: RunnerConfig[];
    /** Tests/embedding may override; installed native service uses the production preparer. */
    prepareInputs?: NonNullable<RelayedSessionDeps["prepareInputs"]>;
    git?: NativeGitTool;
    /** Shared object cache across every configured local agent. */
    repositoryCacheRoot?: string;
    prepareRepositoryWorktree?: (cwd: string, agentId: string) => Promise<void | "unavailable" | "skipped" | "wired">;
    runtimeOptions?: NativeRunnerOptions["runtimeOptions"];
    /** Host agents the installation lists but could not find or verify at load; left out and retried (opencode CP6). */
    unavailableAgents?: NativeUnavailableAgent[];
    /** The connector's QA browser (O8); resolved from the runners' packages and the person's Node when absent (tests pass it). */
    browser?: ConnectorBrowserStatus;
    /** Test/embedding seam for the independently supervised shared Codex owner. */
    codexAppServerOptions?: Omit<NativeCodexAppServerOwnerOptions, "config">;
    /** Self-update policy; absent means the connector only reports `update_required`. */
    update?: Pick<NativeUpdateCoordinatorOptions, "fetchManifest" | "launch" | "readLedger" | "checkIntervalMs" | "initialDelayMs" | "maxAttemptsPerRelease" | "attemptWindowMs" | "staleAttemptMs">;
    /**
     * This release and the update ledger: while an update is still checking
     * this release (its health gate), it takes no new work, so a rollback
     * never stops it under a claim (D113b).
     */
    updateProbation?: { releaseId: string; readLedger: () => Promise<NativeUpdateLedger>; pollMs?: number; staleAttemptMs?: number };
  };
}

export class Supervisor {
  readonly config: SupervisorConfig;
  readonly logger: Logger;
  readonly clock = new SystemClock();
  readonly store: SupervisorStore;
  private readonly shutdownProgressStore: SupervisorStore;
  readonly journal: SupervisorJournal;
  readonly outbox: DurableOutbox;
  readonly lease: LeaseState;
  private key!: InstanceKeyPair;
  private instanceId: string | null = null;
  private workspaceId: string | null = null;
  /** Present exactly where this build speaks the 2.0 assignment protocol. */
  private assignmentSender: AssignmentSender | null = null;
  private administrativeStatus: SupervisorStatus["administrativeStatus"] = "unknown";
  private nativeRelease: VerifiedNativeRelease | null = null;
  private modelCapabilities: ModelCapabilitySnapshotProducer | null = null;
  private roots: EmbeddedReleaseRoot[] = [];
  private manifestDigest = "";
  /** Core's desired configuration; native, with no roles, until Core sends one. */
  private configuration: ConfigRecord["configuration"] = DEFAULT_CONFIG;
  private hostSettings = { openCodeFreeModels: false, coreAcceptsRouteBilling: false };
  /** The Core wire-contract version from the applied desired configuration (absent before one is applied). */
  private coreContractVersion: string | undefined;
  /** Runs `integration` work (external-integration CP2); composed with the native runners. */
  private integrationCarrier: IntegrationWorkCarrier | undefined;
  private roleBindings: RoleBinding[] = [];
  private draining = false;
  /** An update is still checking this release; no new work until it keeps it (D113b). */
  private onUpdateProbation = false;
  private probationTimer: NodeJS.Timeout | null = null;
  private drainReason: string | null = null;
  /** Non-null only for a Core directive; the local operator cannot lift that one. */
  private drainDeadline: string | null = null;
  private pendingRevocation = false;
  private lastSnapshot: InventorySnapshot | null = null;
  /** This release's `konteks-remote` commands at its bundle version (runtime-view R20), built once; null when the table or version does not parse. */
  private connectorCommandsCache: { manifest: ConnectorCommandsManifest | null } | null = null;
  private connectorCommands(): ConnectorCommandsManifest | undefined {
    this.connectorCommandsCache ??= { manifest: connectorCommandsManifest(this.config.SUPERVISOR_BUNDLE_VERSION) };
    return this.connectorCommandsCache.manifest ?? undefined;
  }
  /** The cached detection of supported agents the installation does not list (runtime-view R21). */
  private notAddedAgents: NotAddedAgentsDetector | null = null;
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
  mux!: ChannelMux;
  relay!: RelayClient | null;
  transport!: TransportManager;
  inventory!: NativeInventoryCollector;
  heartbeat!: HeartbeatPublisher;
  control!: ControlHandlers;
  private observationDelivery!: ObservationDelivery;
  private configurationAcks!: ConfigurationAckDelivery;
  private executionRevisionFenceReceipts!: ExecutionRevisionFenceReceiptDelivery;
  work!: WorkOrchestrator;
  private planningTerminal!: PlanningTerminalDirectiveProcessor;
  private planningDirectivePoller: ControllerDirectivePoller | null = null;
  reconciliation!: Reconciliation;
  /** The `preview:<sessionId>` relay channels, forwarded to each session's own loopback preview. */
  previewChannel!: PreviewChannel;
  /** Each session's supervised preview dev server (at most one per session). */
  readonly previews: PreviewProcessManager;
  private readonly previewRegistry: PreviewProcessRegistry;
  /** Worktrees a viewer may start a preview in, by session; kept across releases and restarts while the worktree exists. */
  private readonly previewWorktrees: PreviewWorktreePermits;
  /** When a viewer last started each session's preview (to pace retries after a failure). */
  private readonly previewViewerStarts = new Map<string, number>();
  broker!: PermissionBroker;
  readonly runners = new Map<string, RunnerPort>();
  private readonly nativeRunners: NativeRunner[] = [];
  private nativeCodexOwner: NativeCodexAppServerOwner | null = null;
  /** The QA browser every agent's sessions get (O8), or why this connector has none. */
  private connectorBrowser: ConnectorBrowserStatus = { available: false, reason: "no_package", message: "" };
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;
  private nativeOwnership: NativeRootLock | null = null;
  private readonly runnerIncarnation = randomUUID();
  private readonly stateMutations: StateMutationGate;
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
  /** Cleared on every relay generation change; gates may use it only while its
   * captured socket assertion still proves the same signed delivery path. */
  private revisionFenceConnection: {
    connectionRef: string;
    connectionEpoch: number;
    assertCurrent(): void;
  } | null = null;
  private configurationTimer: NodeJS.Timeout | null = null;
  private configurationRefresh: Promise<void> | null = null;
  private activeLoopStarted = false;
  private ordinaryHeartbeatStarted = false;
  private activeLoopStarting: Promise<void> | null = null;
  private recoveryRetryTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private livenessWatchingSince: number | null = null;
  private livenessQuietWarned = false;
  /** Since when Core has refused this runtime's credential (401/403) without a success in between. */
  private leaseRefusedSince: number | null = null;
  private refusedBundleUpdateAt: number | null = null;
  /** Why Core refused the last startup reconnect, in plain words for `doctor`; null once it is accepted. */
  private reconnectRefusal: string | null = null;
  private refusedRestartTimer: NodeJS.Timeout | null = null;
  private pendingHeartbeatTimer: NodeJS.Timeout | null = null;
  private readonly activeLogins = new Map<string, { agentId: string; emit: (event: ControlLoginEvent) => void }>();
  /** Site-started steps waiting on the person at a window on this computer, by login id. */
  private readonly onComputerWatches = new Map<string, NodeJS.Timeout>();
  private turnActivityTimer: NodeJS.Timeout | null = null;

  constructor(config: SupervisorConfig = loadSupervisorConfig(), private readonly options: SupervisorOptions = {}) {
    this.config = config;
    this.logger = createLogger({ name: "supervisor" });
    this.stateMutations = new StateMutationGate(() => {
      if (!this.nativeOwnership) throw new RemoteInstanceError("temporarily_unavailable", "Native state ownership has not been acquired.");
      this.nativeOwnership.assertOwned();
    });
    this.store = new SupervisorStore(config.SUPERVISOR_DATA_DIR, this.stateMutations.run);
    // Keep diagnostics outside the mutation queue that shutdown itself waits to close.
    this.shutdownProgressStore = new SupervisorStore(config.SUPERVISOR_DATA_DIR);
    this.journal = new SupervisorJournal(this.store.path("journal"), this.stateMutations.run);
    this.outbox = new DurableOutbox(this.store.path("outbox"), this.stateMutations.run);
    this.lease = new LeaseState(this.clock);
    this.previewRegistry = new PreviewProcessRegistry(join(config.SUPERVISOR_DATA_DIR, "preview-processes.json"));
    this.previewWorktrees = new PreviewWorktreePermits(join(config.SUPERVISOR_DATA_DIR, "preview-worktrees.json"));
    this.previews = new PreviewProcessManager({
      idleMs: config.SUPERVISOR_PREVIEW_IDLE_MINUTES * 60_000,
      maxRunning: config.SUPERVISOR_PREVIEW_MAX_RUNNING,
      registry: this.previewRegistry,
      onStopped: sessionId => this.previewChannel?.previewStopped(sessionId),
      logger: this.logger,
    });
  }

  // ── Startup ────────────────────────────────────────────────────────────────

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new RemoteInstanceError("temporarily_unavailable", "Supervisor is stopping."));
    this.startPromise ??= this.startImpl();
    return this.startPromise;
  }

  private async startImpl(): Promise<void> {
    if (!this.options.native) throw new RemoteInstanceError("protocol_incompatible", "Native supervisor composition requires explicit native dependencies.");
    this.nativeOwnership = acquireNativeRootLock(this.config.SUPERVISOR_DATA_DIR, { onLost: () => {
      this.logger.error("native state ownership lost; stopping without reacquisition");
      void this.stop().catch(() => this.logger.error("native ownership-loss shutdown failed"));
    } });
    await this.store.init();
    // A restart never adopts a preview: kill what a crashed process left running.
    await this.previewRegistry.sweep().catch(error => this.logger.warn({ err: error }, "leftover preview processes could not be checked"));
    await this.journal.load();
    await this.outbox.load();
    await this.beginUpdateProbation();
    // A native machine that has an identity but no key has lost the only
    // proof of who it is. A fresh key would be refused by Core on every call
    // while the process looked alive (W1-L1), so it stops and says so;
    // `konteks-remote onboard` connects the machine again as a new runtime.
    const knownIdentity = await this.store.identity().catch(() => null);
    const existingKey = knownIdentity ? await this.store.loadInstanceKey() : null;
    if (knownIdentity && !existingKey) {
      throw new RemoteInstanceError("install_state_corrupt", MACHINE_KEY_LOST);
    }
    this.key = existingKey ?? await this.store.loadOrCreateInstanceKey();
    this.roots = (this.options.native.trustedRoots ?? []).map(root => EmbeddedReleaseRootSchema.parse(root));
    const identity = await this.store.identity();
    const manifest = await this.store.manifest();
    this.instanceId = identity?.instanceId ?? null;
    this.workspaceId = identity?.workspaceId ?? null;
    this.administrativeStatus = identity?.administrativeStatus ?? "unknown";
    this.manifestDigest = manifest?.manifestDigest ?? "";
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
    const storedLease = await this.store.lease();
    if (storedLease) {
      const claims = decodeStoredLeaseClaims(storedLease.lease, { instanceId: this.instanceId!, audience: LEASE_AUDIENCE });
      if (claims.workspace_id !== this.workspaceId || storedLease.workspaceId !== this.workspaceId) throw new RemoteInstanceError("registration_mismatch", "lease workspace does not match the native activation");
      const expected = leaseRecordFromClaims(storedLease.lease, claims);
      if (storedLease.mode !== expected.mode
        || Date.parse(storedLease.expiresAt) !== Date.parse(expected.expiresAt)
        || Date.parse(storedLease.issuedAt) !== Date.parse(expected.issuedAt)
        || (storedLease.drainDeadline === null ? null : Date.parse(storedLease.drainDeadline))
          !== (expected.drainDeadline === null ? null : Date.parse(expected.drainDeadline))) {
        throw new RemoteInstanceError("registration_mismatch", "stored lease metadata does not match its decoded claims");
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
    this.observationDelivery = new ObservationDelivery({ outbox: this.outbox, core: this.core,
      instanceId: () => this.instanceId ?? "", clock: this.clock, logger: this.logger,
      canSend: () => !this.stopping && Boolean(this.instanceId) && Boolean(this.lease.current()) && this.recoveryAuthority() !== null });
    this.observationDelivery.start();
    this.configurationAcks = new ConfigurationAckDelivery({ outbox: this.outbox, core: this.core, instanceId: () => this.instanceId ?? "", clock: this.clock, canSend: () => !this.stopping && Boolean(this.instanceId) });
    this.executionRevisionFenceReceipts = new ExecutionRevisionFenceReceiptDelivery({ outbox: this.outbox, core: this.core, clock: this.clock, canSend: () => !this.stopping && Boolean(this.instanceId), logger: this.logger });
    const sharedCodex = this.options.native!.runners.find(config => config.RUNNER_AGENT_ID === "codex" && config.RUNNER_NATIVE_CODEX_SOCKET !== undefined);
    if (sharedCodex) this.nativeCodexOwner = new NativeCodexAppServerOwner({
      ...this.options.native!.codexAppServerOptions,
      config: sharedCodex,
      onRestartFailure: error => this.logger.warn({ err: error }, "shared Codex app-server restart failed; retrying"),
    });
    // The QA browser is the connector's, not an agent package's (O8): every
    // agent's sessions get it when an installed Claude Code or Codex package
    // carries it and some Node can run it.
    this.connectorBrowser = this.options.native!.browser ?? await resolveConnectorBrowser(this.options.native!.runners);
    if (this.connectorBrowser.available) {
      this.logger.info({ event: "browser.connector_ready", packageAgent: this.connectorBrowser.browser.packageAgent, nodeSource: this.connectorBrowser.browser.nodeSource }, "the QA browser is available to every agent on this computer");
    } else {
      this.logger.warn({ event: "browser.connector_unavailable", reason: this.connectorBrowser.reason }, this.connectorBrowser.message);
    }
    this.nativeRunnerInstanceId = identity!.instanceId;
    for (const config of withConnectorBrowser(this.options.native!.runners, this.connectorBrowser)) {
      const runner = this.createNativeRunner(config);
      this.nativeRunners.push(runner);
      this.runners.set(runner.agentId, runner);
    }
    // external-integration CP2: integration tasks (discovery, setup, gated
    // read/write/verify sessions) on this computer's Claude Code and Codex.
    this.integrationCarrier = composeIntegrationCarrier({
      configs: this.options.native!.runners,
      runners: () => this.runners,
      fetchWorkload: assignment => this.core.fetchWorkload(this.instanceId ?? "", assignment.id),
      instanceId: () => this.instanceId ?? "",
      journal: this.journal,
      onUsage: observation => this.sendUsageObservation(observation),
      logger: this.logger,
    });
    // Supported agents the installation does not list: detected now, in the
    // background, so the first heartbeat can already say where they stand.
    const recorded = this.recordedAgentIds();
    this.notAddedAgents = new NotAddedAgentsDetector({ agentIds: SUPPORTED_AGENT_IDS.filter(agentId => !recorded.has(agentId)) });
    void this.notAddedAgents.refreshIfDue().catch(() => undefined);
    // The personal Claude Code executable a claude-code runner runs: its
    // version and digest ride the capabilities (S0-5).
    const claudeExecutable = this.options.native!.runners.find(runner => runner.RUNNER_AGENT_ID === "claude-code")?.RUNNER_NATIVE_CLAUDE_EXECUTABLE;
    const claudeIdentity = claudeExecutable ? new ClaudeExecutableIdentity(claudeExecutable, { logger: this.logger }) : null;
    this.inventory = new NativeInventoryCollector({ runners: this.runners, sampler: new SignalSampler(this.config.SUPERVISOR_DATA_DIR), bundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
      gitVersion: () => this.git.version(),
      ...(claudeIdentity ? { claudeExecutable: () => claudeIdentity.capability() } : {}),
      executionPermitsReady: () => {
        // Native sessionDeps below always composes NativeExecutionGate.
        // Advertise only once that work owner exists and is still owned.
        if (!this.work || !this.nativeOwnership || this.stopping) return false;
        try { this.nativeOwnership.assertOwned(); return true; } catch { return false; }
      },
      // A site-started login needs a native install with a Codex runner (WS1-115).
      agentLoginReady: () => this.runners.has("codex") && !this.stopping && this.relay !== null && this.relay !== undefined,
      agentLoginBrowserReady: () => this.runners.has("claude-code") && !this.stopping && this.relay !== null && this.relay !== undefined && machineHasDesktop(),
      additionalCapabilities: () => [...this.openCodeCapabilities(), ...this.antigravityCapabilities(), ...this.onComputerCapabilities(), ...(this.browserToolReady() ? [BROWSER_TOOL_CAPABILITY] : []),
        ...(this.integrationCarrier ? integrationTaskCapabilities(this.runners.keys()) : [])],
      decorateAgents: agents => this.withAntigravityDownload(agents),
      // Previews reach a viewer only over the relay's preview channel.
      previewReady: () => this.previewCapable(),
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
      mappings: () => this.nativeRelease ? selectNativeModelCapabilityMappings(this.nativeRelease, {
        os: this.config.SUPERVISOR_PLATFORM_OS,
        architecture: this.config.SUPERVISOR_PLATFORM_ARCH,
      }) : [],
      // Every installed native agent reports what it offers; one the release
      // signed no mapping for does so under its catalogue authority.
      catalogueAgents: () => this.nativeRunners.map(runner => runner.agentId),
      discover: async (agentId, configId) => {
        const runner = this.nativeRunners.find(candidate => candidate.agentId === agentId);
        if (!runner) throw new RemoteInstanceError("agent_unavailable", "Reviewed model mapping has no installed native runner.");
        return runner.discoverModelCapability(configId);
      },
      // OpenCode's routes bill by provider and credential (O7, O11); only a
      // 7.1.0 Core takes the field (the shape is strict and digested).
      optionBilling: (agentId, value, agent) => (!this.hostSettings.coreAcceptsRouteBilling ? undefined
        : agentId === "opencode" ? openCodeOptionBilling(agent, value) : agentId === "antigravity" ? antigravityOptionBilling(agent) : undefined),
    });

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
    // A preview stream never outlives the process that served it, and Core
    // opens every preview grant counting from zero: counts kept from the last
    // process made the new one drop Core's first requests as duplicates and
    // answer out of sequence after an update (W1-Z7). They start fresh.
    const durableChannelOf = (channelId: string) => {
      const channel = channelOf(channelId);
      return channel === "preview" ? null : channel;
    };
    if (relayState) this.mux.restoreDurableState(relayState, durableChannelOf);
    else this.mux.restoreCursors(await this.store.cursors(), durableChannelOf);
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
          onStateChange: (state) => {
            if (state !== "connected") this.revisionFenceConnection = null;
            this.transport.evaluate();
          },
          validateHandshake: result => this.validateRelayHandshake(result),
          onConnected: result => this.onRelayConnected(result),
          onAgentLogin: request => this.onAgentLogin(request, verifier),
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
          onDiagnosticCompanion: async (request, connection) => {
            const lease = this.lease.current();
            const instanceId = this.instanceId;
            const workspaceId = this.workspaceId;
            const runnerIncarnation = this.runnerIncarnation;
            const ownership = this.nativeOwnership;
            const receiver = new DiagnosticCompanionReceiver({
              verifier,
              inbox: this.journal.diagnosticCompanions,
              now: () => this.clock.coreNow(),
              onAccepted: record => {
                const match = record.companion.match;
                const active = this.journal.activeAssignments().find(entry =>
                  entry.assignmentId === match.assignmentId && entry.attempt === match.attempt,
                );
                const retained = active ? this.journal.execution.start(match.assignmentId, match.attempt) : undefined;
                const operation = active && retained && active.claimId === retained.admission.claimId
                  ? {
                      assignmentId: active.assignmentId,
                      attempt: active.attempt,
                      claimId: retained.admission.claimId,
                      executionId: retained.admission.executionGeneration,
                      runtimeIncarnationId: retained.admission.runnerIncarnation,
                    }
                  : null;
                const observation = diagnosticCompanionOperationalObservation(record, operation);
                if (observation.event === "runtime.diagnostic_companion.coverage_incomplete") {
                  this.logger.warn(observation, "diagnostic companion coverage is incomplete");
                } else {
                  this.logger.info(observation, "diagnostic companion persisted for active operation");
                }
              },
              captureConnection: () => lease && instanceId && workspaceId && ownership ? {
                instanceId,
                workspaceId,
                runnerIncarnation,
                nodeId: request.nodeId,
                connectionRef: request.connectionRef,
                connectionEpoch: connection.connectionEpoch,
                assertCurrent: () => {
                  connection.assertCurrent();
                  if (this.stopping || this.nativeOwnership !== ownership ||
                    this.lease.current() !== lease || this.instanceId !== instanceId ||
                    this.workspaceId !== workspaceId ||
                    this.runnerIncarnation !== runnerIncarnation) {
                    throw new RemoteInstanceError("recovery_required", "Diagnostic companion ownership is not current");
                  }
                  ownership.assertOwned();
                },
              } : null,
            });
            await receiver.receive(request);
          },
          onExecutionRevisionControl: async (request, connection) => {
            const lease = this.lease.current();
            const instanceId = this.instanceId;
            const workspaceId = this.workspaceId;
            const runnerIncarnation = this.runnerIncarnation;
            const ownership = this.nativeOwnership;
            const accepted = this.recoveryAuthority();
            const assertCurrent = () => {
              connection.assertCurrent();
              if (this.stopping || !lease || !instanceId || !workspaceId || !ownership ||
                  this.nativeOwnership !== ownership || this.lease.current() !== lease ||
                  this.instanceId !== instanceId || this.workspaceId !== workspaceId ||
                  this.runnerIncarnation !== runnerIncarnation || this.recoveryAuthority() !== accepted) {
                throw new RemoteInstanceError("recovery_required", "Revision-control native ownership is not current");
              }
              ownership.assertOwned();
            };
            const receiver = new ExecutionRevisionControlReceiver({
              verifier,
              inbox: this.journal.executionRevisionFences,
              now: () => this.clock.coreNow(),
              monotonicNow: () => performance.now(),
              captureConnection: () => lease && instanceId && workspaceId && ownership && accepted ? {
                instanceId,
                workspaceId,
                runnerIncarnation,
                nodeId: request.nodeId,
                connectionRef: request.connectionRef,
                connectionEpoch: connection.connectionEpoch,
                assertCurrent,
              } : null,
            });
            await receiver.receive(request);
            assertCurrent();
            this.revisionFenceConnection = {
              connectionRef: request.connectionRef,
              connectionEpoch: connection.connectionEpoch,
              assertCurrent,
            };
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
      relayOnlySessions: true,
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
    // The to_core window per preview channel: a quarter of the replay bound,
    // so a large response waits for the viewer's acknowledgements instead of
    // evicting replay and resetting the channel.
    const previewWindowBytes = Math.max(256 * 1024, Math.min(2 * 1024 * 1024, Math.floor(this.config.SUPERVISOR_REPLAY_BUFFER_BYTES / 4)));
    this.previewChannel = new PreviewChannel({
      transport: this.transport,
      lease: this.lease,
      previews: {
        originFor: sessionId => this.previews.originFor(sessionId),
        touch: sessionId => this.previews.touch(sessionId),
        autoStart: sessionId => this.startPreviewForViewer(sessionId),
      },
      hasCapacity: channelId => this.mux.unackedBytes(channelId) < previewWindowBytes,
      logger: this.logger,
    });

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
      onConfigurationApplied: (configuration) => {
        this.configuration = configuration;
        this.roleBindings = (configuration.roleBindings ?? []).map(binding => ({ role: binding.role, agentPreference: [...binding.agentPreference] }));
        this.applyHostSettings(configuration);
      },
      localCapacity: () => Math.max(1, (this.lastSnapshot?.agents.filter((agent) => agent.readiness === "ready").length ?? 1) * 4),
      onDrain: async (directive) => this.beginDrain(directive.reason, directive.drainDeadline ?? null),
      eraseAssignments: (ids) => this.eraseAssignments(ids),
      eraseAll: () => this.eraseAll(),
      onUpdateRequired: (policy) => {
        const updates = this.ensureUpdates();
        if (updates) updates.onUpdateRequired(policy);
        else this.logger.warn({ minimumSupportedBundle: policy.minimumSupportedBundle }, "update_required: bundle below Core's minimum");
      },
      sendAck: (ack) => this.sendControlAck(ack),
    });
    await this.control.load();

    this.broker = new PermissionBroker({ clock: this.clock, deadlineSeconds: () => this.configuration.permissionResponderDeadlineSeconds, onTimeout: async (request) => this.work.onPermissionTimeout(request) });
    this.work = new WorkOrchestrator({
      verifyCancellation: directive => verifier.verify(directive, directive.signature),
      onSessionReleased: sessionId => {
        // The dev server stops with the session; its worktree stays openable
        // by a viewer while it exists (a delivery's preview after the delivery).
        this.previewViewerStarts.delete(sessionId);
        void this.previews.stop(sessionId, "session_released");
      },
      ...(this.assignmentSender ? { assignmentSender: this.assignmentSender } : {}),
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
      roleCapabilityInputs: () => this.roleCapabilityInputs(),
      // `direct` from a 7.1 Core, `integration` from a 7.3 Core and only while
      // the integration carrier is composed (work/accepted-kinds.ts).
      acceptedKinds: () => acceptedWorkKinds(this.coreContractVersion).filter(kind => kind !== "integration" || this.integrationCarrier !== undefined),
      instanceEvidencePolicy: () => this.configuration.evidenceUpload,
      draining: () => this.draining || this.onUpdateProbation,
      reconciliationComplete: () => this.reconciliation.isComplete,
      recoveryAuthority: () => this.recoveryAuthority(),
      reportDeliveryAllowed: () => this.recoveryAuthority() !== null,
      recoveryEvidence: { submit: (input: Parameters<CoreClient["submitRecoveryEvidence"]>[0]) => this.core.submitRecoveryEvidence(input) },
      recoveryEvidenceConnection: () => ({ kind: "https" as const }),
      canSubmitRecoveryEvidence: () => {
        if (this.stopping || !this.nativeOwnership || this.recoveryAuthority() === null) return false;
        try { this.nativeOwnership.assertOwned(); return true; }
        catch { return false; }
      },
      recoverPendingDeliveryOutput: createRetainedDeliveryOutputRecovery({
        roots: this.options.native!.runners.map(config => config.RUNNER_WORKSPACE_DIR),
        journal: this.journal,
        mutate: this.stateMutations.run,
        logger: this.logger,
        client: () => new NativeOutputClient({
          baseUrl: this.config.SUPERVISOR_CORE_URL, clock: this.clock,
          credential: () => this.lease.mode() === "active" ? this.lease.current()?.lease ?? null : null,
        }),
      }),
      headroom: () => this.headroom(),
      maxPullItems: this.config.SUPERVISOR_PULL_MAX_ITEMS,
      searchController: new DurableSearchAssignmentCarrier(this.journal, this.clock),
      onboardCarrier: this.onboardCarrier(),
      ...(this.integrationCarrier ? { integrationCarrier: this.integrationCarrier } : {}),
      runners: this.runners,
      inspectLegacyCodexThread: reference => this.nativeCodexOwner?.inspectLegacyThread(reference) ?? Promise.reject(new RemoteInstanceError("agent_unavailable", "The shared Codex owner is unavailable.")),
      sessionDeps: (assignment, runner) => ({
        clock: this.clock,
        journal: this.journal,
        transport: this.transport,
        runner,
        onTurnActivity: () => this.nudgeHeartbeat(),
        preview: this.sessionPreviewAccess(),
        policy: new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => this.configuration.humanDeferralAllowed && assignment.policy.humanDeferralAllowed),
        broker: this.broker,
        registerDeferral: (body) => this.core.deferPermission(this.instanceId ?? "", body),
        instanceId: this.instanceId ?? "",
        redeemCapabilityToken: async (target) => {
          const deadlineAtMs = Date.now() + Math.max(0, Date.parse(target.expiresAt) - this.clock.coreNow());
          return this.core.redeemCapabilityToken(this.instanceId ?? "", { assignmentId: target.id, attempt: target.attempt, mcpCapabilityTokenRef: target.agentRoute.mcpCapabilityTokenRef ?? "" }, deadlineAtMs);
        },
        workspaceRoot: this.options.native!.runners.find(config => config.RUNNER_AGENT_ID === runner.agentId)!.RUNNER_WORKSPACE_DIR,
        executionAuthority: {
          client: this.core,
          runnerIncarnation: this.runnerIncarnation,
          onFenceApplied: receipt => this.executionRevisionFenceReceipts.submit(receipt),
          currentRevisionFenceConnection: () => {
            const connection = this.revisionFenceConnection;
            if (!connection) return null;
            connection.assertCurrent();
            return {
              connectionRef: connection.connectionRef,
              connectionEpoch: connection.connectionEpoch,
            };
          },
        },
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
          mutate: this.stateMutations.run,
          ...(this.options.native!.git ? { git: this.options.native!.git } : {}),
          ...(this.options.native!.repositoryCacheRoot
            ? { repositoryCacheRoot: this.options.native!.repositoryCacheRoot }
            : {}),
          ...(this.options.native!.prepareRepositoryWorktree
            ? { prepareRepositoryWorktree: this.options.native!.prepareRepositoryWorktree }
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
      }),
      onUsage: (observation) => this.sendUsageObservation(observation),
    });
    this.cancellationReplay = new CancellationReplay({
      journal: this.journal,
      stopForRecovery: (assignmentId, attempt) => this.work.stopForRecovery(assignmentId, attempt),
      cancelDelivery: directive => this.work.onCancel(directive),
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
    this.planningDirectivePoller = new ControllerDirectivePoller({
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
        if (!this.nativeOwnership) throw new RemoteInstanceError("temporarily_unavailable", "Native state ownership is unavailable.");
        this.nativeOwnership.assertOwned();
      },
      bundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
      protocolVersion: String(REMOTE_INSTANCE_PROTOCOL_VERSION),
      lastHeartbeatSequence: () => this.store.heartbeatSequence(),
      modelCapabilitySnapshots: () => this.modelCapabilities?.snapshots() ?? [],
      reserveHeartbeatFloor: floor => this.store.reserveHeartbeatFloor(floor),
      stopLocalWork: (assignmentId, attempt, assertCurrent) => this.work.stopForRecovery(assignmentId, attempt, assertCurrent),
      cancelAbsentLocalWork: (manifest, decision, assertCurrent) => this.work.cancelAbsentForRecovery(manifest, decision, assertCurrent),
      reports: this.work.reports,
      onLease: (lease, _expiresAt, assertCurrent) => this.adoptLease(lease, assertCurrent),
      afterEstablishment: async assertCurrent => {
        if (this.activeLoopStarted) return;
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
      supportedAgents: agents => this.supportedAgents(agents),
      // The commands this release carries (runtime-view R20), only to a Core that takes 7.1 fields.
      connectorCommands: () => (this.hostSettings.coreAcceptsRouteBilling ? this.connectorCommands() : undefined),
      configRevision: () => this.control.configRevision,
      bundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
      softMaxConcurrent: () => this.configuration.softMaxConcurrent ?? this.config.SUPERVISOR_SOFT_MAX_CONCURRENT,
      acceptingWork: () => !this.draining && !this.onUpdateProbation && this.lease.canPullNewWork() && this.reconciliation.isComplete,
      intervalSeconds: () => this.heartbeatIntervalSeconds ?? this.configuration.heartbeatIntervalSeconds,
      renewalDelayMs: () => this.lease.current() ? this.lease.nextRenewalDelayMs() : 5000,
    });

    for (const runner of this.runners.values()) runner.startEvents();
    const agents = await startNativeAgents({
      codexOwner: this.nativeCodexOwner,
      runners: this.nativeRunners,
      onUnavailable: (agentId, error) => {
        this.agentStartFailures.set(agentId, error);
        this.logger.error({ err: error, agentId }, "agent could not start; the runtime continues without it");
      },
    });
    if (this.nativeCodexOwner && !agents.codexOwnerStarted) {
      // Codex is left out rather than taking every other agent down with it:
      // it is not advertised, so no work is placed on it. It is tried again
      // in the background (WS1-018), so a passing failure does not leave it
      // out until the service happens to restart.
      this.parkedCodex = { owner: this.nativeCodexOwner, runners: this.nativeRunners.filter(candidate => candidate.agentId === "codex") };
      this.scheduleCodexRetry();
      this.nativeCodexOwner = null;
      for (const runner of this.nativeRunners.filter(candidate => candidate.agentId === "codex")) this.runners.delete(runner.agentId);
      for (let index = this.nativeRunners.length - 1; index >= 0; index -= 1) {
        if (this.nativeRunners[index]!.agentId === "codex") this.nativeRunners.splice(index, 1);
      }
    }
    // Any other agent that could not start is left out the same way and
    // retried in the background, so one agent never takes the rest down.
    for (const runner of agents.failed) this.parkNativeRunner(runner);
    for (const entry of this.options.native!.unavailableAgents ?? []) this.parkUnavailableHostAgent(entry);
    this.lastSnapshot = await this.inventory.collect();
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

  private nativeRunnerInstanceId = "";

  private createNativeRunner(config: RunnerConfig): NativeRunner {
    return new NativeRunner({ instanceId: this.nativeRunnerInstanceId, config,
      ...(config.RUNNER_AGENT_ID === "codex" && this.nativeCodexOwner ? { afterSuccessfulLogin: () => this.nativeCodexOwner!.refreshAfterLogin() } : {}),
      executionBridgeLimit: () => Math.min(4, this.configuration.softMaxConcurrent ?? this.config.SUPERVISOR_SOFT_MAX_CONCURRENT ?? 4),
      onEvent: event => { void this.onRunnerEvent(config.RUNNER_AGENT_ID, event).catch(error => this.logger.warn({ err: error }, "native runner event failed")); }, ...(this.options.native!.runtimeOptions ? { runtimeOptions: this.options.native!.runtimeOptions } : {}) });
  }

  /**
   * A host agent (the person's own DeepSeek Harness or OpenCode) that the
   * installation could not find or verify at load (removed, or upgraded out
   * of the supported range) is left out like an agent that failed to start:
   * the connector runs the others, and a background retry re-locates it and
   * builds its runner once it is back.
   */
  private parkUnavailableHostAgent(entry: NativeUnavailableAgent): void {
    this.agentStartFailures.set(entry.agentId, entry.error);
    this.logger.error({ err: entry.error, agentId: entry.agentId }, "agent could not be found or verified; the runtime continues without it");
    // Google Antigravity's update (A17): its `relocate` fetches this release's
    // pin, checks it and switches to it, starting now rather than in a minute.
    this.nativeAgentRetry.park(entry.agentId, async () => {
      const [config] = withConnectorBrowser([await entry.relocate()], this.connectorBrowser);
      const runner = this.createNativeRunner(config!);
      try {
        await runner.start();
      } catch (error) {
        await runner.stop().catch(() => undefined);
        throw error;
      }
      this.parkedRunners.set(entry.agentId, runner);
    }, entry.updating ? { firstDelayMs: 0 } : {});
  }

  /** The last reason each left-out agent could not start (doctor), cleared when it starts. */
  private readonly agentStartFailures = new Map<string, unknown>();

  private readonly nativeAgentRetry = new NativeAgentRetry({
    onStarted: async agentId => {
      const runner = this.parkedRunners.get(agentId);
      this.parkedRunners.delete(agentId);
      this.agentStartFailures.delete(agentId);
      if (!runner || this.stopping) return;
      this.nativeRunners.push(runner);
      this.runners.set(runner.agentId, runner);
      // Core's settings may have changed while it was left out.
      void runner.applyHostSettings(this.hostSettings).catch(error => this.logger.warn({ err: error, agentId }, "host agent settings not applied"));
      // The next heartbeat advertises it; nothing waits for this.
      this.lastSnapshot = await this.inventory.collect().catch(() => this.lastSnapshot);
      this.logger.info({ agentId }, "agent started on a later try; it is advertised again");
    },
    onGaveUp: (agentId, error) => {
      const runner = this.parkedRunners.get(agentId);
      this.parkedRunners.delete(agentId);
      if (runner) this.gaveUpRunners.set(agentId, runner);
      this.agentStartFailures.set(agentId, error);
      this.logger.error({ err: error, agentId }, "agent still could not start after ten tries; restart the connector once it is fixed");
    },
    log: (agentId, attempt, error) => {
      this.agentStartFailures.set(agentId, error);
      this.logger.warn({ err: error, agentId, attempt }, "agent still could not start; trying again later");
    },
  });
  private readonly parkedRunners = new Map<string, NativeRunner>();
  /** Runners the retry gave up on after ten tries; kept only so doctor can still say why. */
  private readonly gaveUpRunners = new Map<string, NativeRunner>();

  /** Leave one runner out of advertising and placement until a retry starts it. */
  private parkNativeRunner(runner: NativeRunner): void {
    this.runners.delete(runner.agentId);
    const index = this.nativeRunners.indexOf(runner);
    if (index >= 0) this.nativeRunners.splice(index, 1);
    this.parkedRunners.set(runner.agentId, runner);
    this.nativeAgentRetry.park(runner.agentId, () => runner.start());
  }

  private parkedCodex: { owner: NativeCodexAppServerOwner; runners: NativeRunner[] } | null = null;
  private codexRetryTimer: NodeJS.Timeout | null = null;
  private codexRetryAttempt = 0;

  /** Try a Codex that could not start again: a minute, then doubling, at most ten times. */
  private scheduleCodexRetry(): void {
    if (this.stopping || !this.parkedCodex || this.codexRetryAttempt >= 10) return;
    const delay = Math.min(60_000 * 2 ** this.codexRetryAttempt, 15 * 60_000);
    this.codexRetryTimer = setTimeout(() => { void this.retryCodex(); }, delay);
    this.codexRetryTimer.unref?.();
  }

  private async retryCodex(): Promise<void> {
    this.codexRetryTimer = null;
    const parked = this.parkedCodex;
    if (this.stopping || !parked) return;
    try {
      await parked.owner.start();
      for (const runner of parked.runners) await runner.start();
    } catch (error) {
      this.codexRetryAttempt += 1;
      this.agentStartFailures.set("codex", error);
      this.logger.warn({ err: error, attempt: this.codexRetryAttempt }, "codex still could not start; trying again later");
      this.scheduleCodexRetry();
      return;
    }
    if (this.stopping) return;
    this.parkedCodex = null;
    this.agentStartFailures.delete("codex");
    this.nativeCodexOwner = parked.owner;
    for (const runner of parked.runners) {
      this.nativeRunners.push(runner);
      this.runners.set(runner.agentId, runner);
    }
    // The next heartbeat advertises it; nothing waits for this.
    this.lastSnapshot = await this.inventory.collect().catch(() => this.lastSnapshot);
    this.logger.info("codex started on a later try; it is advertised again");
  }

  private provisioningCredential: string | null = null;
  private provisioningLoopActive = false;

  /** Refresh is coalesced across provisioning, periodic polling and reconnect. */
  refreshConfiguration(): Promise<void> {
    if (this.stopping || !this.instanceId || !this.control) return Promise.resolve();
    this.configurationRefresh ??= (async () => {
      try {
        await this.configurationAcks.flush();
        await this.executionRevisionFenceReceipts.flush();
        if (this.stopping) return;
        const desired = await this.core.fetchDesiredConfiguration(this.instanceId!);
        this.leaseRefusedSince = null;
        if (!this.stopping) await this.control.handle(desired);
      } catch (error) {
        // Core answered and refused the credential: the lapsed-lease signal the
        // liveness watchdog acts on. An unreachable Core is not a refusal.
        if (isCredentialRefusal(error)) this.leaseRefusedSince ??= Date.now();
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
        await this.startActiveLoop();
        if (this.activeLoopStarted) return;
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
      // The logger keeps no stack, and every local-history refusal says the same
      // sentence: name where it came from, or a stuck recovery is undiagnosable.
      const at = error instanceof Error ? error.stack?.split("\n").slice(1, 6).map(line => line.trim().replace(/^at /, "")).join(" < ") : undefined;
      this.logger.warn({ err: error, ...(at ? { at } : {}) }, "startup recovery remains pending");
      const record = this.journal.recovery.current(this.instanceId ?? "", this.runnerIncarnation);
      const terminal = record && record.state !== "pending" && record.state !== "applied";
      const denied = this.administrativeStatus === "revoked" || (error instanceof RemoteInstanceError && ["instance_revoked", "registration_mismatch", "reconciliation_replay", "resume_deadline_expired"].includes(error.code));
      // Core retired this process's recovery generation (or it expired, or
      // another establishment won): this incarnation can never be accepted
      // again, and retrying it is refused forever. A new process is a new
      // incarnation that establishes through the ordinary path, so restart.
      const retired = this.administrativeStatus !== "revoked" && !(error instanceof RemoteInstanceError && ["instance_revoked", "registration_mismatch"].includes(error.code)) &&
        (terminal || (error instanceof RemoteInstanceError && ["reconciliation_replay", "resume_deadline_expired"].includes(error.code)));
      this.reconnectRefusal = this.describeReconnectRefusal(error, retired);
      // Below Core's minimum no start can succeed: only an update gets back in.
      if (error instanceof RemoteInstanceError && error.code === "update_required") this.requestUpdateForRefusedBundle();
      if (retired && !this.stopping && !this.activeLoopStarted) this.restartForRetiredProcess(error);
      if (!this.stopping && !this.activeLoopStarted && !terminal && !denied && !this.recoveryRetryTimer) {
        this.recoveryRetryTimer = setTimeout(() => { this.recoveryRetryTimer = null; void this.startActiveLoop(); }, 15_000);
        this.recoveryRetryTimer.unref();
      }
    }).finally(() => { this.activeLoopStarting = null; });
    this.activeLoopStarting = operation;
    return operation;
  }

  /** Plain words for `doctor` when Core refused the startup reconnect; null for a passing failure. */
  private describeReconnectRefusal(error: unknown, retired: boolean): string | null {
    if (retired) return "Konteks no longer accepts this connector process; it restarts to reconnect as a new one";
    if (!(error instanceof RemoteInstanceError)) return null;
    if (error.code === "update_required") return `Konteks refuses release ${this.config.SUPERVISOR_BUNDLE_VERSION} for this computer (${error.message}); it needs an update to the release Konteks accepts`;
    if (error instanceof CoreResponseError && error.status >= 400 && error.status < 500) return `Konteks refused the reconnect: ${error.message}`;
    return null;
  }

  /**
   * Restart once, shortly, after Core refused this incarnation for good. The
   * service manager starts a new process, which establishes a fresh
   * incarnation; the delay keeps two processes that keep replacing each
   * other from spinning.
   */
  private restartForRetiredProcess(error: unknown): void {
    if (this.refusedRestartTimer) return;
    this.refusedRestartTimer = setTimeout(() => {
      if (this.stopping || this.activeLoopStarted) return;
      const detail = { reason: "recovery_refused", code: error instanceof RemoteInstanceError ? error.code : "unknown" };
      this.logger.error(detail, "Konteks no longer accepts this connector process; restarting to reconnect as a new one");
      this.options.onLivenessLost?.(detail);
    }, 15_000);
    this.refusedRestartTimer.unref();
  }

  /** At most one channel read per interval while startup keeps being refused as too old (it retries every 15 s). */
  private requestUpdateForRefusedBundle(): void {
    const now = Date.now();
    if (this.refusedBundleUpdateAt !== null && now - this.refusedBundleUpdateAt < REFUSED_BUNDLE_UPDATE_INTERVAL_MS) return;
    this.refusedBundleUpdateAt = now;
    const updates = this.ensureUpdates();
    if (!updates) { this.logger.warn("Core refuses this release as too old and automatic updates are off; update with `konteks-remote update`"); return; }
    updates.onUpdateRequired({ minimumSupportedBundle: null });
  }

  private leaseLapseNeedsRestart(): boolean {
    return leaseLapseNeedsRestart({ now: Date.now(), stopping: this.stopping, activeLoopStarted: this.activeLoopStarted, refusedSince: this.leaseRefusedSince,
      leaseMode: this.lease.mode(), administrativeStatus: this.administrativeStatus, thresholdMs: LEASE_LAPSE_RESTART_MS });
  }

  /** From the first recovery cycle on, some heartbeat (pending or ordinary) is
   * always due. When none has even been attempted for longer than the
   * publisher's budget, every loop is stuck behind one promise; say so with
   * the gates that are pending, then hand the process to its service manager. */
  private startLivenessWatchdog(): void {
    if (this.livenessTimer) return;
    this.livenessWatchingSince = Date.now();
    this.livenessTimer = setInterval(() => {
      if (this.stopping || !this.livenessTimer) return;
      if (this.leaseLapseNeedsRestart()) {
        clearInterval(this.livenessTimer);
        this.livenessTimer = null;
        const detail = { reason: "lease_lapsed", leaseMode: this.lease.mode(), leaseExpiresAt: this.lease.current()?.expiresAt ?? null,
          refusedForMs: Date.now() - (this.leaseRefusedSince ?? Date.now()), administrativeStatus: this.administrativeStatus };
        this.logger.error(detail, "the lease lapsed and Core refuses it; restarting to reconnect with this machine's key");
        this.options.onLivenessLost?.(detail);
        return;
      }
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
    if (this.instanceId) this.openCoreChannels(this.instanceId);
    await this.refreshConfiguration();
    if (this.stopping) return;
    this.requireRecoveryAuthority();
    if (!this.configurationTimer) {
      this.configurationTimer = setInterval(() => void this.refreshConfiguration(), 30_000);
      this.configurationTimer.unref();
    }
    if (!this.ordinaryHeartbeatStarted) {
      await this.heartbeat.start();
      this.ordinaryHeartbeatStarted = true;
    }
    if (this.stopping) return;
    this.requireRecoveryAuthority();
    this.activeLoopStarted = true;
    this.reconnectRefusal = null;
    void this.resumeOnComputerWatches().catch(error => this.logger.warn({ err: error }, "on-computer steps not resumed"));
    this.transport.start();
    this.planningDirectivePoller?.start();
    this.transport.resumeAfterRecovery();
    this.pullTimer = setInterval(() => this.work.pull(), 5_000);
    this.pullTimer.unref();
    // bb: every 5 minutes release sessions idle for 30 minutes.
    this.reaperTimer = setInterval(() => void this.work.reapIdleCompletedSessions(IDLE_SESSION_RELEASE_MS).catch(() => undefined), IDLE_SESSION_SWEEP_MS);
    this.reaperTimer.unref();
    this.previews.startIdleSweep();
    this.ensureUpdates()?.start();
    await this.work.reports.flushAll();
  }

  /**
   * The unattended update, built on first need: after a successful start, or
   * when Core refuses the startup reconnect because this bundle is below its
   * minimum (then no start ever succeeds, and only an update gets back in).
   */
  private ensureUpdates(): NativeUpdateCoordinator | null {
    const update = this.options.native?.update;
    if (update && !this.updates) {
      this.updates = new NativeUpdateCoordinator({
        ...update,
        currentBundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
        trustedRoots: this.options.native!.trustedRoots,
        logger: this.logger,
        canApply: () => this.stopping ? { ok: false, reason: "supervisor is stopping" } : this.draining && this.drainReason !== "update" ? { ok: false, reason: `draining (${this.drainReason ?? "unknown"})` } : { ok: true },
        // Only a release Core accepts is installed unattended (WS1-093).
        acceptedRelease: async () => {
          if (!this.instanceId) throw new Error("no instance identity yet");
          return this.core.acceptedRelease(this.instanceId);
        },
      });
    }
    return this.updates ?? null;
  }

  private async onRelayConnected(result: RelayRuntimeHandshakeResult): Promise<void> {
    // Reconnect completes before any channel other than control reopens.
    try {
      this.validateRelayHandshake(result);
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
      if (!this.nativeOwnership) throw new RemoteInstanceError("temporarily_unavailable", "Native state ownership is unavailable.");
      this.nativeOwnership.assertOwned();
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
    const claims = decodeLeaseClaims(lease, { instanceId: this.instanceId ?? "", audience: LEASE_AUDIENCE });
    if (claims.workspace_id !== this.workspaceId) throw new RemoteInstanceError("registration_mismatch", "lease workspace does not match the native activation");
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
    const claims = decodeLeaseClaims(result.lease, { instanceId: this.instanceId ?? "", audience: LEASE_AUDIENCE });
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
        void this.previews.stopAll("lease_lost");
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
        // Answered asynchronously on the stream; receipt is not the response.
        this.previewChannel.onToRuntime(message.channelId, message.body);
        return;
    }
  }

  private async onChannelReset(channelId: string): Promise<void> {
    const channel = channelOf(channelId);
    if (channel === "session") await this.work.onChannelReset(channelId);
    else if (channel === "preview") this.previewChannel.closeChannel(channelId);
    else if (channel === "assignment" || channel === "observation") await this.work.reports.flushAll();
  }

  private async onRunnerEvent(agentId: string, event: Parameters<WorkOrchestrator["onRunnerEvent"]>[0]): Promise<void> {
    if (event.kind === "readiness_changed") {
      this.inventory.updateAgent(event.agent);
      if (this.lastSnapshot) this.lastSnapshot = { ...this.lastSnapshot, agents: this.inventory.agents() };
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

  private async sendUsageObservation(observation: AgentTurnUsageObservation): Promise<void> {
    await this.observationDelivery.submit(observation);
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
    // Previews of sessions still working stop with those sessions; the rest
    // (a finished turn's preview left open) stop now.
    const live = this.work.liveSessionIds();
    for (const preview of this.previews.list()) if (!live.has(preview.sessionId)) void this.previews.stop(preview.sessionId, "drain");
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

  /**
   * What a session's preview tools may do: start, stop and read that session's
   * own preview. Starting is refused while this computer takes no new work;
   * a start waits (bounded) for the dev server to answer or fail so the agent
   * gets a useful first answer.
   */
  private sessionPreviewAccess(): SessionPreviewAccess {
    return {
      start: async (sessionId, cwd) => {
        if (this.stopping || this.draining || this.lease.mode() !== "active") {
          return { ...this.previews.status(sessionId), message: "This computer is not taking new work right now, so a preview cannot start." };
        }
        const started = await this.previews.start(sessionId, cwd);
        return started.state === "starting" ? this.previews.waitForSettled(sessionId, PREVIEW_START_WAIT_MS) : started;
      },
      stop: (sessionId, reason) => this.previews.stop(sessionId, reason),
      status: sessionId => this.previews.status(sessionId),
      touch: sessionId => this.previews.touch(sessionId),
      permit: (sessionId, cwd) => this.previewWorktrees.set(sessionId, cwd),
      forget: sessionId => this.forgetPreviewWorktree(sessionId),
      origin: sessionId => this.previews.originFor(sessionId),
      // Playwright's own Chromium, when this computer has no Chrome, is installed here once.
      browsersPath: join(this.config.SUPERVISOR_DATA_DIR, "browsers"),
    };
  }

  /**
   * A viewer opened this session's preview and nothing runs: start it, with
   * the same process manager, inference and caps preview_start uses, when the
   * session's worktree exists and this computer takes work. True while one is
   * starting (the viewer is told "Starting preview" and its page refreshes).
   * A preview that just failed is not restarted on every refresh.
   */
  private async startPreviewForViewer(sessionId: string): Promise<boolean> {
    const current = this.previews.status(sessionId);
    if (current.state === "starting") return true;
    if (this.stopping || this.draining || this.lease.mode() !== "active") return false;
    const cwd = this.previewWorktrees.get(sessionId);
    if (cwd === undefined || !existsSync(cwd)) return false;
    const last = this.previewViewerStarts.get(sessionId);
    if (current.state === "failed" && last !== undefined && Date.now() - last < PREVIEW_VIEWER_RETRY_MS) return false;
    this.previewViewerStarts.set(sessionId, Date.now());
    const started = await this.previews.start(sessionId, cwd, "viewer");
    if (started.state !== "starting" && started.state !== "running") {
      this.logger.info({ event: "preview.viewer_start_refused", state: started.state }, "a viewer's preview could not start");
      return false;
    }
    this.logger.info({ event: "preview.viewer_started" }, "a viewer started this session's preview");
    return true;
  }

  private forgetPreviewWorktree(sessionId: string): void {
    this.previewWorktrees.delete(sessionId);
    this.previewViewerStarts.delete(sessionId);
  }

  /**
   * Every agent's sessions get the QA browser (O8) while the connector has
   * one and previews can run (a session is given the browser with its
   * preview); Core may then place QA on any of them.
   */
  private browserToolReady(): boolean {
    return this.connectorBrowser.available && this.previewCapable();
  }

  /** Which agents drive the QA browser (Playwright MCP), on which Node, whether it uses Chrome or Playwright's Chromium, or why there is none. */
  private browserReport(): { version: string | null; agents: string[]; chrome: boolean; packageAgent?: string; nodeSource?: "agent_package" | "person"; unavailable?: string } {
    const agents: string[] = [];
    let version: string | null = null;
    for (const [agentId, runner] of this.runners) {
      const offered = runner.browserVersion?.() ?? null;
      if (offered === null) continue;
      agents.push(agentId);
      version ??= offered;
    }
    const browser = this.connectorBrowser;
    return { version, agents: agents.sort(), chrome: chromeInstalled(),
      ...(browser.available ? { packageAgent: browser.browser.packageAgent, nodeSource: browser.browser.nodeSource } : version === null && browser.message ? { unavailable: browser.message } : {}) };
  }

  private previewCapable(): boolean {
    return !this.stopping && this.relay !== null && this.relay !== undefined;
  }

  /** Status's preview fields: the first running preview's port and whether a viewer reached it. */
  private previewExposure(): { previewEnabled: boolean; previewExposure: { port: number; grantPresent: boolean } | null } {
    const running = this.previews.list().find(preview => preview.state === "running" && preview.port !== null);
    return running
      ? { previewEnabled: true, previewExposure: { port: running.port!, grantPresent: this.previewChannel?.hasViewer(running.sessionId) ?? false } }
      : { previewEnabled: false, previewExposure: null };
  }

  private previewReport(): PreviewStatusReport {
    const health = this.previews.health();
    return {
      capabilityAdvertised: this.previewCapable(),
      idleStopMinutes: this.config.SUPERVISOR_PREVIEW_IDLE_MINUTES,
      maxRunning: this.config.SUPERVISOR_PREVIEW_MAX_RUNNING,
      previews: this.previews.list().map(preview => ({
        sessionId: preview.sessionId, state: preview.state, url: preview.url, port: preview.port, command: preview.command, source: preview.source,
        explanation: preview.explanation, message: preview.message, startedAt: preview.startedAt, readyAt: preview.readyAt,
        startedBy: preview.startedBy,
        viewerConnected: this.previewChannel?.hasViewer(preview.sessionId) ?? false,
      })),
      lastFailure: health.lastFailure,
    };
  }

  /** The non-agent facts a role may depend on; one source for every reader. */
  private roleCapabilityInputs(): RoleCapabilityInputs {
    return { gitVersion: this.lastSnapshot?.gitVersion ?? null };
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
      utilization: { acceptingWork: !this.draining && !this.onUpdateProbation && this.lease.canPullNewWork(), activeSessions: this.lastSnapshot?.activeSessions ?? 0, activeTurns: this.lastSnapshot?.activeTurns ?? 0, utilizationRatio: Math.min(1, this.lastSnapshot?.hostPressure ?? 0), ...(this.configuration.softMaxConcurrent === undefined ? {} : { softMaxConcurrent: this.configuration.softMaxConcurrent }) },
      pendingErase: this.journal.erase.all().filter((record) => !record.receiptSent).length,
      pendingRevocation: this.pendingRevocation,
      // Also read by launchers installed before 7.0.0, which require both fields.
      ...this.previewExposure(),
      journal: { assignments: this.journal.activeAssignments().length, outboxDepth: this.outbox.depth, recoveryRequired: this.journal.recoveryRequired().length },
    };
  }

  controlHandler(): ControlHandler {
    return async (request, emit) => {
      switch (request.op) {
        case "status":
          return this.status();
        case "agents": {
          const agents = this.lastSnapshot?.agents ?? this.inventory.agents();
          return { agents: [...agents, ...this.leftOutAgents(agents)], roles: this.heartbeat?.roles() ?? [], roleBindings: this.roleBindings };
        }
        case "auth.status":
          return { agents: (this.lastSnapshot?.agents ?? this.inventory.agents()).filter((agent) => request.agentId === undefined || agent.agentId === request.agentId) };
        case "auth.login": {
          const runner = this.requireRunner(request.agentId);
          const loginId = `login-${randomUUID()}`;
          this.activeLogins.set(loginId, { agentId: request.agentId, emit: (event) => emit.event(event) });
          emit.signal.addEventListener("abort", () => {
            if (!this.activeLogins.delete(loginId)) return;
            void runner.loginCancel(loginId).catch(error => this.logger.warn({ err: error }, "orphaned local login cancellation failed"));
          }, { once: true });
          // The person ran this on their own machine: their own login (WS1-115).
          const which = { ...(request.provider === undefined ? {} : { provider: request.provider }), ...(request.method === undefined ? {} : { method: request.method }),
            ...(request.reuse === undefined ? {} : { reuse: request.reuse }),
            // Gemini Enterprise's project and location, both or neither (the runner checks them again).
            ...(request.project !== undefined && request.location !== undefined ? { gcp: AgentLoginGcpSchema.parse({ project: request.project, location: request.location }) } : {}) };
          try {
            if (Object.keys(which).length > 0) await runner.login(request.organization, loginId, true, which);
            else await runner.login(request.organization, loginId, true);
            if (emit.signal.aborted) {
              await runner.loginCancel(loginId);
              throw new RemoteInstanceError("temporarily_unavailable", "login caller disconnected");
            }
          } catch (error) {
            this.activeLogins.delete(loginId);
            throw error;
          }
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
          this.activeLogins.delete(request.loginId);
          await this.requireRunner(login.agentId).loginCancel(request.loginId);
          login.emit({ kind: "failed", loginId: request.loginId, code: "login_cancelled", message: "login cancelled" });
          return {};
        }
        case "auth.logout": {
          const which = { ...(request.provider === undefined ? {} : { provider: request.provider }), ...(request.method === undefined ? {} : { method: request.method }) };
          return Object.keys(which).length === 0 ? this.requireRunner(request.agentId).logout() : this.requireRunner(request.agentId).logout(which);
        }
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
        case "drain":
          return { activeAssignments: await this.beginDrain(request.reason, null) };
        case "drain.status":
          return { draining: this.draining, reason: this.drainReason, activeAssignments: this.work.activeCount(), openSessions: this.work.openSessions() };
        case "codex.maintenance.preflight": {
          if (!this.draining || this.drainReason !== "update" || this.work.activeCount() !== 0 || this.stopping) {
            throw new RemoteInstanceError("active_work", "The update drain has not settled for Codex maintenance.");
          }
          await this.nativeCodexOwner?.preflightMaintenance();
          return { idle: true };
        }
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
        case "update.channel": {
          // Its own op, not a status field: launchers from older releases read
          // `status` strictly and a user install never replaces its launcher.
          const channel = this.updates ? this.updateChannelReport() : null;
          return channel ? { host: channel.host, override: channel.override, lastCheckedAt: channel.lastCheckedAt, error: channel.lastError } : null;
        }
        case "release.accepted": {
          if (!this.instanceId) return { bundleVersion: null };
          const accepted = await this.core.acceptedRelease(this.instanceId);
          return { bundleVersion: accepted?.bundleVersion ?? null };
        }
        case "preview.status":
          return this.previewReport();
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
            counters: { relay: { ...this.mux.counters }, control: { ...this.control.counters }, work: { ...this.work.counters } },
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
        case "shutdown": {
          // Answered first, then stopped, so the caller hears it was accepted.
          setTimeout(() => {
            if (this.options.onShutdownRequested) this.options.onShutdownRequested();
            else void this.stop().catch(() => undefined);
          }, 200).unref?.();
          return { stopping: true };
        }
        case "instance.retire": {
          if (!this.instanceId) throw new RemoteInstanceError("temporarily_unavailable", "This runtime is not activated, so there is nothing to remove from Konteks.");
          const result = await this.core.retire(this.instanceId);
          if (result.outcome !== "draining") {
            // Removed from its workspace, a runtime has nothing left to do:
            // it stops once this answer is sent, so uninstall never deletes a
            // folder out from under a process still running in it.
            this.administrativeStatus = "removed";
            setTimeout(() => {
              if (this.options.onRetired) this.options.onRetired();
              else void this.stop().catch(() => undefined);
            }, 500).unref?.();
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

  /**
   * A login the person started from the site for an agent on this machine
   * (WS1-115). Core signed it for this runtime; the runner runs the agent's
   * official device login in the person's own profile, and only the provider
   * link and code go back to Core. A login that asks for typed input is
   * stopped: nothing the person types may cross Konteks.
   */
  private async onAgentLogin(request: RuntimeAgentLoginDeliveryRequest, verifier: CoreSignatureVerifier): Promise<void> {
    if (!verifier.verifyAgentLoginDelivery(request)) {
      throw new RemoteInstanceError("permission_denied", "Core agent login signatures are required");
    }
    const { intent } = request;
    const instanceId = this.instanceId;
    if (!instanceId || intent.instanceId !== instanceId || intent.tenantId !== this.workspaceId) {
      throw new RemoteInstanceError("recovery_required", "This agent login is for another runtime");
    }
    if (intent.loginOption === ON_COMPUTER_LOGIN_OPTION && (ON_COMPUTER_AGENTS as readonly string[]).includes(intent.agentId)) {
      await this.startOnComputer(instanceId, intent.loginId, intent.agentId as OnComputerAgent, intent.action);
      return;
    }
    if (intent.agentId !== "codex" && intent.agentId !== "claude-code" && intent.agentId !== "opencode" && intent.agentId !== "antigravity") {
      if (intent.action !== "cancel") {
        await this.core.reportAgentLogin(instanceId, { loginId: intent.loginId, agentId: intent.agentId, state: "failed", failure: "unavailable" } as Parameters<CoreClient["reportAgentLogin"]>[1])
          .catch(error => this.logger.warn({ err: error, loginId: intent.loginId }, "agent login report not delivered"));
      }
      return;
    }
    // An OpenCode or Antigravity login names its sign-in option; every report
    // echoes it. Another agent's option is never started (the runner offers
    // only its own). Gemini Enterprise carries its Google Cloud project.
    const optionAgent = intent.agentId === "opencode" || intent.agentId === "antigravity";
    const requestedOption = optionAgent && intent.loginOption !== undefined ? AgentLoginOptionIdSchema.safeParse(intent.loginOption) : undefined;
    const loginOption = requestedOption?.success ? requestedOption.data : undefined;
    const gcp = intent.agentId === "antigravity" && loginOption === "gemini-enterprise" && intent.gcp !== undefined ? intent.gcp : undefined;
    const report = (value: Parameters<CoreClient["reportAgentLogin"]>[1]) =>
      this.core.reportAgentLogin(instanceId, { ...value, ...(loginOption === undefined ? {} : { loginOption }) } as Parameters<CoreClient["reportAgentLogin"]>[1])
        .catch(error => this.logger.warn({ err: error, loginId: intent.loginId }, "agent login report not delivered"));
    if (intent.action === "cancel") {
      const login = this.activeLogins.get(intent.loginId);
      if (login) {
        this.activeLogins.delete(intent.loginId);
        await this.requireRunner(login.agentId).loginCancel(intent.loginId).catch(() => undefined);
      }
      return;
    }
    // A repeated delivery of a login already under way changes nothing.
    if (this.activeLogins.has(intent.loginId)) return;
    const runner = this.runners.get(intent.agentId);
    if (!runner) {
      await report({ loginId: intent.loginId, agentId: intent.agentId, state: "failed", failure: "unavailable" });
      return;
    }
    // A sign-in this machine does not offer (any more) is not started; nor a
    // Gemini Enterprise sign-in without its project.
    if ((requestedOption !== undefined && !requestedOption.success) || (loginOption !== undefined && !(runner.siteLoginOptions?.() ?? []).includes(loginOption))
        || (intent.agentId === "antigravity" && (loginOption === undefined || (loginOption === "gemini-enterprise" && gcp === undefined)))) {
      await report({ loginId: intent.loginId, agentId: intent.agentId, state: "failed", failure: "unavailable" });
      return;
    }
    const relay = siteLoginRelay({ loginId: intent.loginId, agentId: intent.agentId, ...(loginOption === undefined ? {} : { loginOption }),
      coreAcceptsNoLicense: this.hostSettings.coreAcceptsRouteBilling,
      report: value => { void report(value); },
      cancel: () => { void runner.loginCancel(intent.loginId).catch(() => undefined); },
      onFinished: () => { this.activeLogins.delete(intent.loginId); },
      // Ready shows on the site now, not at the next heartbeat.
      onSucceeded: () => { if (this.activeLoopStarted) void this.heartbeat.publish().catch(error => this.logger.warn({ err: error }, "heartbeat after login failed")); },
    });
    this.activeLogins.set(intent.loginId, { agentId: intent.agentId, emit: event => relay.emit(event) });
    try {
      if (loginOption === undefined) await runner.login(false, intent.loginId, true);
      else await runner.login(false, intent.loginId, true, { loginOption, ...(gcp ? { gcp } : {}) });
      relay.started();
    } catch (error) {
      const busy = error instanceof RemoteInstanceError && /already in progress/i.test(error.message);
      relay.fail(busy ? "already_in_progress" : "unavailable");
    }
  }

  /**
   * A step the person asked for on the site, brought to the front here
   * (on-computer): from where the agent stands, a window on this computer runs
   * its install, its add and its sign-in at the connector's own prompt, and
   * the person answers there. Core hears that it waits on them (with the step),
   * then that it worked once the agent reads ready. A cancel stops the watch;
   * the window is the person's to close.
   */
  private async startOnComputer(instanceId: string, loginId: string, agentId: OnComputerAgent, action: "start" | "cancel"): Promise<void> {
    const report = this.onComputerReporter(instanceId, loginId, agentId);
    if (action === "cancel") { await this.stopOnComputerWatch(loginId); return; }
    if (this.onComputerWatches.has(loginId)) return;
    const facts = this.onComputerFacts(agentId);
    if (!facts) { await report({ state: "failed", failure: "unavailable" }); return; }
    if (onComputerDone(facts.state)) { await report({ state: "succeeded" }); return; }
    const plan = planOnComputer({ agentId, state: facts.state, ...(facts.installCommand ? { installCommand: facts.installCommand } : {}), ...(facts.windowsInstallCommand ? { windowsInstallCommand: facts.windowsInstallCommand } : {}) }, process.platform);
    if (!plan) { await report({ state: "failed", failure: "unavailable" }); return; }
    const root = dirname(this.config.SUPERVISOR_DATA_DIR);
    // A stand-in laptop's window loads the stand-in's own terminal settings.
    const prelude = process.env.KONTEKS_E2E_NATIVE_CONNECTOR === "1" ? standInTerminalEnv(root) : undefined;
    // This release's own launcher, never the install-day one in bin (it is not updated).
    const launcher = releaseLauncher();
    try {
      const { file, opened } = await openOnComputer({ loginId, script: onComputerScript(plan, { agentId, root, platform: process.platform, ...(prelude ? { prelude } : {}), ...(launcher ? { launcher } : {}) }), dataDir: this.config.SUPERVISOR_DATA_DIR, platform: process.platform, confined: prelude !== undefined });
      this.logger.info({ event: opened ? "on_computer.opened" : "on_computer.left_for_tester", loginId, agentId, step: plan.step, file },
        opened ? "site-started step brought to the front on this computer" : "site-started step left in the stand-in's folder; no window opened");
    } catch (error) {
      this.logger.warn({ err: error, loginId, agentId }, "site-started step could not be opened on this computer");
      await report({ state: "failed", failure: "unavailable" });
      return;
    }
    await report({ state: "awaiting_person", step: plan.step });
    const watch: OnComputerWatch = { instanceId, loginId, agentId, until: plan.until, deadline: Date.now() + ON_COMPUTER_WATCH_MS };
    // Kept on disk: adding an agent restarts this connector, and the step must
    // still end (and say so on the site) in the connector that comes back.
    await writeOnComputerWatch(this.config.SUPERVISOR_DATA_DIR, watch).catch(error => this.logger.warn({ err: error, loginId }, "on-computer step not kept across a restart"));
    this.watchOnComputer(watch);
  }

  private onComputerReporter(instanceId: string, loginId: string, agentId: OnComputerAgent) {
    type Report = Parameters<CoreClient["reportAgentLogin"]>[1];
    return (value: Omit<Report, "loginId" | "agentId" | "loginOption">) =>
      this.core.reportAgentLogin(instanceId, { loginId, agentId, loginOption: ON_COMPUTER_LOGIN_OPTION, ...value } as Report)
        .catch(error => this.logger.warn({ err: error, loginId }, "agent login report not delivered"));
  }

  private onComputerFacts(agentId: OnComputerAgent) {
    return this.supportedAgents(this.lastSnapshot?.agents ?? [])?.find(entry => entry.agentId === agentId);
  }

  /**
   * A turn started or ended: publish a heartbeat shortly (once for a burst), so
   * the runtime's busy bar and counter move with the work. A short turn used
   * to fall between two 30 s heartbeats and never showed at all (WS1-179).
   */
  private nudgeHeartbeat(): void {
    if (!this.activeLoopStarted || this.stopping || this.turnActivityTimer) return;
    this.turnActivityTimer = setTimeout(() => {
      this.turnActivityTimer = null;
      if (!this.activeLoopStarted || this.stopping) return;
      void this.heartbeat.publish().catch(error => this.logger.warn({ err: error }, "heartbeat after a turn change failed"));
    }, TURN_ACTIVITY_HEARTBEAT_MS);
    this.turnActivityTimer.unref();
  }

  /** Looks every few seconds whether the step's agent reads ready (or, for an add, added); says so once, or that it ran out of time. */
  private watchOnComputer(watch: OnComputerWatch): void {
    const report = this.onComputerReporter(watch.instanceId, watch.loginId, watch.agentId);
    const tick = () => {
      const now = this.onComputerFacts(watch.agentId);
      if (now && onComputerDone(now.state, watch.until)) {
        void this.stopOnComputerWatch(watch.loginId);
        void report({ state: "succeeded" });
        if (this.activeLoopStarted) void this.heartbeat.publish().catch(error => this.logger.warn({ err: error }, "heartbeat after an on-computer step failed"));
      } else if (Date.now() > watch.deadline) {
        void this.stopOnComputerWatch(watch.loginId);
        void report({ state: "failed", failure: "timed_out" });
      }
    };
    const timer = setInterval(tick, ON_COMPUTER_POLL_MS);
    timer.unref?.();
    this.onComputerWatches.set(watch.loginId, timer);
  }

  private async stopOnComputerWatch(loginId: string): Promise<void> {
    const timer = this.onComputerWatches.get(loginId);
    if (timer) clearInterval(timer);
    this.onComputerWatches.delete(loginId);
    await removeOnComputerWatch(this.config.SUPERVISOR_DATA_DIR, loginId).catch(() => undefined);
  }

  /** Steps an earlier run of this connector left waiting (it restarted to add an agent): watched again until they end. */
  private async resumeOnComputerWatches(): Promise<void> {
    const instanceId = this.instanceId;
    if (!instanceId) return;
    for (const watch of await readOnComputerWatches(this.config.SUPERVISOR_DATA_DIR).catch(() => [])) {
      if (watch.instanceId !== instanceId || this.onComputerWatches.has(watch.loginId)) continue;
      this.logger.info({ event: "on_computer.resumed", loginId: watch.loginId, agentId: watch.agentId }, "site-started step watched again after a restart");
      this.watchOnComputer(watch);
    }
  }

  /** Whether this computer can bring a site-started step to the front: a desktop (or a stand-in's spool) and a relay to hear it. */
  private onComputerCapabilities(): string[] {
    const relayReady = !this.stopping && this.relay !== null && this.relay !== undefined;
    return relayReady && this.options.native && canOpenOnComputer(machineHasDesktop()) ? [REMOTE_AGENT_LOGIN_ON_COMPUTER_CAPABILITY] : [];
  }

  /**
   * Core's host-agent settings from an applied desired configuration: OpenCode
   * Zen's free models (absent = off, O6) and whether Core takes 7.1 fields
   * (pay-per-use turns and route billing, an offered option's billing,
   * `hostAgentDownload`, a credential's and a site sign-in's `no_license`).
   * The latter is the Core wire-contract version Core signs into every
   * revision for a connector advertising `core-contract-version-v1`
   * (inventory.ts); no fallback on the free-models field, which no released
   * Core ever sent (antigravity CP6). A change drops OpenCode's model
   * snapshots.
   */
  private applyHostSettings(configuration: ConfigRecord["configuration"]): void {
    this.coreContractVersion = configuration.coreContractVersion;
    const settings = { openCodeFreeModels: configuration.openCodeFreeModelsEnabled === true, coreAcceptsRouteBilling: coreContractAtLeast(configuration.coreContractVersion, "7.1") };
    const changed = this.hostSettings.openCodeFreeModels !== settings.openCodeFreeModels || this.hostSettings.coreAcceptsRouteBilling !== settings.coreAcceptsRouteBilling;
    this.hostSettings = settings;
    for (const runner of this.runners.values()) {
      if (!runner.applyHostSettings) continue;
      void runner.applyHostSettings(settings).catch(error => this.logger.warn({ err: error, agentId: runner.agentId }, "host agent settings not applied"));
      if (changed) this.modelCapabilities?.invalidateAgent(runner.agentId);
    }
  }

  /**
   * The agents this installation lists that could not start, as unavailable,
   * for `agents` and `doctor` (RCA 2026-10-01: a Codex left out at start was
   * simply missing there, so the update health gate kept waiting for its
   * probe until its deadline and blamed the probe). Only agents this release
   * bundles: the person's own host agents have their own doctor checks and
   * never hold an update back. Not in the heartbeat: Core hears of them
   * through `supportedAgents`.
   */
  private leftOutAgents(listed: readonly { agentId: string }[]): Array<{ agentId: string; readiness: "unavailable"; connectionState: "unavailable"; startFailure: string }> {
    const present = new Set(listed.map(agent => agent.agentId));
    return [...this.recordedAgentIds()]
      .filter(agentId => !isHostAgentId(agentId) && !present.has(agentId) && !this.runners.has(agentId) && this.agentStartFailures.has(agentId))
      .map(agentId => {
        const failure = this.agentStartFailures.get(agentId);
        const reason = (failure instanceof Error ? failure.message : `${agentId} could not start`).replace(/\.$/, "").slice(0, 300);
        return { agentId, readiness: "unavailable" as const, connectionState: "unavailable" as const, startFailure: reason };
      });
  }

  /** The agents this installation lists: its runners and the host agents left out at load. */
  private recordedAgentIds(): Set<string> {
    const native = this.options.native;
    return new Set([...(native?.runners ?? []).map(config => config.RUNNER_AGENT_ID), ...(native?.unavailableAgents ?? []).map(entry => entry.agentId)]);
  }

  /**
   * Every supported agent's real state on this computer (runtime-view R21),
   * only to a Core that takes 7.1 fields (the heartbeat is strict there). A
   * listed agent from its runner, or from why it is left out; the others
   * from the cached detection, re-run in the background on the agent retry
   * cadence, never on this path. Nothing until that detection first ended.
   */
  private supportedAgents(agents: readonly ConnectedAgentView[]) {
    const detector = this.notAddedAgents;
    if (!this.options.native || !detector || !this.hostSettings.coreAcceptsRouteBilling) return undefined;
    void detector.refreshIfDue().catch(() => undefined);
    if (!detector.detectedOnce()) return undefined;
    const added = new Map<string, AddedAgentFacts>();
    for (const agentId of this.recordedAgentIds()) {
      const live = this.nativeRunners.find(runner => runner.agentId === agentId && this.runners.get(agentId) === runner);
      const view = live ? agents.find(agent => agent.agentId === agentId) : undefined;
      const version = (live ?? this.parkedRunners.get(agentId) ?? this.gaveUpRunners.get(agentId))?.hostInstallation()?.version;
      added.set(agentId, live && view
        ? { view, signInLost: live.signInLost(), ...(version ? { version } : {}) }
        : { failure: this.agentStartFailures.get(agentId), ...(version ? { version } : {}) });
    }
    return projectSupportedAgents({ added, notAdded: detector.current() });
  }

  /** What this connector advertises for OpenCode: the free-models switch, and the sign-ins the site may start here. */
  private openCodeCapabilities(): string[] {
    const runner = this.runners.get("opencode");
    return openCodeRunnerCapabilities({ installed: runner !== undefined, relayReady: !this.stopping && this.relay !== null && this.relay !== undefined,
      options: runner?.siteLoginOptions?.() ?? [], desktop: machineHasDesktop() });
  }

  /**
   * Google Antigravity's download state on its connected agent (CP3 prep),
   * only to a Core that takes it (a 7.1.0 Core; the view is strict there).
   * While no runner of it can start (not downloaded, or its copy fails the
   * start checks) it is reported as an unavailable agent carrying that state,
   * so the site can say what to do.
   */
  private async withAntigravityDownload(agents: ConnectedAgentView[]): Promise<ConnectedAgentView[]> {
    const native = this.options.native;
    if (!native || !this.hostSettings.coreAcceptsRouteBilling) return agents;
    const root = dirname(this.config.SUPERVISOR_DATA_DIR);
    const record = this.antigravityRecordFields();
    // Not added (the installation does not list it): the site's add card
    // shows "Not added" with the one command (A20), or the download while
    // `agent add antigravity` fetches it in the launcher (the service keeps
    // running meanwhile). Nothing where Google publishes no copy for this
    // computer.
    const download = await antigravityDownloadState(root, record ?? undefined).catch(() => undefined);
    return download ? withAntigravityDownload(agents, download) : agents;
  }

  /**
   * The copy of Google Antigravity this installation runs or names: a live
   * runner's (after an update switched it, too), else the load's; null when
   * the installation does not list it.
   */
  private antigravityRecordFields(): Pick<NativeRuntimeRecord, "antigravityVersion" | "antigravityRoot"> | null {
    const native = this.options.native;
    if (!native) return null;
    const runner = this.nativeRunners.find(candidate => candidate.agentId === "antigravity") ?? this.parkedRunners.get("antigravity") ?? this.gaveUpRunners.get("antigravity");
    const live = runner?.hostInstallation();
    if (live?.fetchedRoot !== undefined) return { antigravityVersion: live.version, antigravityRoot: live.fetchedRoot };
    const unavailable = native.unavailableAgents?.find(entry => entry.agentId === "antigravity");
    if (unavailable) return unavailable.fetched ?? {};
    const config = native.runners.find(candidate => candidate.RUNNER_AGENT_ID === "antigravity");
    if (config?.RUNNER_NATIVE_ANTIGRAVITY_ROOT !== undefined) return { antigravityVersion: config.RUNNER_BRIDGE_VERSION, antigravityRoot: config.RUNNER_NATIVE_ANTIGRAVITY_ROOT };
    return null;
  }

  /** What this connector advertises for Google Antigravity: its Gemini Enterprise sign-in from the site (CP3). */
  private antigravityCapabilities(): string[] {
    const runner = this.runners.get("antigravity");
    return antigravityRunnerCapabilities({ installed: runner !== undefined, relayReady: !this.stopping && this.relay !== null && this.relay !== undefined,
      options: runner?.siteLoginOptions?.() ?? [], desktop: machineHasDesktop() });
  }

  private requireRunner(agentId: string): RunnerPort {
    const runner = this.runners.get(agentId);
    if (!runner) throw new RemoteInstanceError("agent_unavailable", `no runner for agent ${agentId}`, { recoveryActions: [{ kind: "run_doctor" }] });
    return runner;
  }

  private async doctor() {
    const snapshot = this.lastSnapshot ?? (await this.inventory.collect());
    const openCode = this.openCodeDoctor(snapshot.agents);
    const antigravity = await this.antigravityDoctor(snapshot.agents).catch(() => undefined);
    return runDoctor({
      now: () => this.clock.nowIso(),
      dataDir: this.config.SUPERVISOR_DATA_DIR,
      identity: { instanceId: this.instanceId, administrativeStatus: this.administrativeStatus },
      lease: { mode: this.lease.mode(), expiresAt: this.lease.current()?.expiresAt ?? null },
      relay: this.relay?.status() ?? { state: "offline", lastError: "relay not configured", consecutiveFailures: 0 },
      transport: this.transport.kind,
      reconciliationComplete: this.reconciliation.isComplete,
      ...(this.reconnectRefusal ? { reconciliationRefusal: this.reconnectRefusal } : {}),
      components: snapshot.components,
      agents: [...snapshot.agents, ...this.leftOutAgents(snapshot.agents)],
      // The snapshot may carry the site's "Not added" Google Antigravity view
      // (only after a fresh collect, so a long-running release did not show
      // it and a just-started one did): an update gate read it as a failure.
      ...(this.options.native ? { listedAgents: [...this.recordedAgentIds()] } : {}),
      configRevision: this.control.configRevision,
      diskFreeBytes: snapshot.diskFreeBytes,
      // Native releases name no disk minimum; the check reports free space only.
      minimumDiskBytes: 0,
      outboxDepth: this.outbox.depth,
      recoveryRequired: this.journal.recoveryRequired().length,
      coreSignatureConfigured: this.roots.some((root) => (root.coreControlKeys ?? []).length > 0),
      preview: { advertised: this.previewCapable(), running: this.previews.health().running, lastFailureAt: this.previews.health().lastFailure?.at ?? null },
      browser: this.browserReport(),
      ...(openCode ? { openCode } : {}),
      ...(antigravity ? { antigravity } : {}),
      ...(this.updates ? { updateChannel: this.updateChannelReport() } : {}),
      ...(this.options.native && process.platform === "win32" ? { launcher: await windowsInstalledLauncher().catch(() => null) } : {}),
    });
  }

  /** The unattended update's channel for `doctor`: host only, never the full URL. */
  private updateChannelReport(): NonNullable<Parameters<typeof runDoctor>[0]["updateChannel"]> {
    const update = this.updates!.channel();
    let host: string;
    let override = false;
    try {
      const url = new URL(nativeManifestUrl(process.env));
      host = url.host;
      override = url.toString() !== NATIVE_MANIFEST_URL;
    } catch (error) {
      return { host: "(invalid override)", override: true, lastCheckedAt: update.lastCheckedAt, lastError: error instanceof Error ? error.message : String(error), available: null };
    }
    return { host, override, lastCheckedAt: update.lastCheckedAt, lastError: update.error, available: update.available };
  }

  /** The Google Antigravity doctor line's facts, when this installation lists it (running, updating, retried or given up). */
  private async antigravityDoctor(agents: Array<{ agentId: string; credentials?: Array<{ label: string; state: string; method?: string | undefined; reason?: string | undefined }> | undefined }>): Promise<AntigravityDoctorInputs | undefined> {
    const running = this.nativeRunners.find(runner => runner.agentId === "antigravity" && this.runners.get("antigravity") === runner);
    const retrying = this.nativeAgentRetry.parked().includes("antigravity");
    const gaveUp = this.gaveUpRunners.get("antigravity");
    if (!running && !retrying && !gaveUp && !this.agentStartFailures.has("antigravity")) return undefined;
    const root = dirname(this.config.SUPERVISOR_DATA_DIR);
    let pin: ReturnType<typeof antigravityPin> | null = null;
    try { pin = antigravityPin(); } catch { pin = null; }
    const installation = (running ?? this.parkedRunners.get("antigravity") ?? gaveUp)?.hostInstallation() ?? null;
    const record = this.antigravityRecordFields();
    const download = record === null ? undefined : (await antigravityDownloadState(root, record).catch(() => undefined))?.state;
    const failure = this.agentStartFailures.get("antigravity");
    const updating = retrying && this.options.native?.unavailableAgents?.some(entry => entry.agentId === "antigravity" && entry.updating === true) === true;
    const observation = await readAntigravityAdminObservation(join(root, "credentials", "antigravity")).catch(() => null);
    return {
      state: running ? "running" : retrying ? "retrying" : "given_up",
      pinnedVersion: pin?.version ?? null,
      ...(download === undefined ? {} : { download }),
      selfCheck: installation?.selfCheck ?? "not_run",
      failure: failure instanceof RemoteInstanceError ? failure.diagnostic : undefined,
      updating,
      credentials: (agents.find(agent => agent.agentId === "antigravity")?.credentials ?? [])
        .map(credential => ({ label: credential.label, state: credential.state, method: credential.method, reason: credential.reason })),
      quarantine: running?.quarantineReason() ?? null,
      mcpServersOffAt: observation?.mcpServersOffAt ?? null,
      diskBytes: pin && (download === "ready" || download === "update_available") ? antigravityDiskBytes(pin) : null,
      browser: running ? running.browserVersion() !== null : this.connectorBrowser.available,
    };
  }

  /** The OpenCode doctor line's facts, when this installation lists OpenCode (running, retried or given up). */
  private openCodeDoctor(agents: Array<{ agentId: string; credentials?: Array<{ label: string; state: string }> | undefined }>): OpenCodeDoctorInputs | undefined {
    const running = this.nativeRunners.find(runner => runner.agentId === "opencode" && this.runners.get("opencode") === runner);
    const retrying = this.nativeAgentRetry.parked().includes("opencode");
    const gaveUp = this.gaveUpRunners.get("opencode");
    if (!running && !retrying && !gaveUp && !this.agentStartFailures.has("opencode")) return undefined;
    const installation = (running ?? this.parkedRunners.get("opencode") ?? gaveUp)?.hostInstallation() ?? null;
    const failure = this.agentStartFailures.get("opencode");
    return {
      state: running ? "running" : retrying ? "retrying" : "given_up",
      version: installation?.version ?? null,
      installKind: installation?.executable ? openCodeInstallKind(installation.executable) : null,
      selfCheck: installation?.selfCheck ?? "not_run",
      failure: failure instanceof RemoteInstanceError ? failure.diagnostic : undefined,
      credentials: (agents.find(agent => agent.agentId === "opencode")?.credentials ?? []).map(credential => ({ label: credential.label, state: credential.state })),
      freeModels: this.hostSettings.openCodeFreeModels,
      browser: running ? running.browserVersion() !== null : this.connectorBrowser.available,
    };
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
    if (this.refusedRestartTimer) clearTimeout(this.refusedRestartTimer);
    this.refusedRestartTimer = null;
    if (this.probationTimer) clearInterval(this.probationTimer);
    this.probationTimer = null;
    this.cancelDrainTimer();
    this.stopPromise ??= this.stopImpl();
    return this.stopPromise;
  }

  private async stopImpl(): Promise<void> {
    const note = async (phase: ShutdownProgress["phase"], state: ShutdownProgress["state"]): Promise<void> => {
      // Diagnostics must never prevent cleanup or change the shutdown receipt.
      if (!this.options.native) return;
      await this.shutdownProgressStore.recordShutdownProgress(phase, state).catch((err: unknown) => {
        this.logger.warn({ err }, "shutdown progress could not be recorded");
      });
    };
    await note("supervisor_prelude", "entered");
    // A stop that hung here (09-30 15:23) left no clue which wait held it:
    // every wait that takes longer than a few seconds is named in the log.
    const waitFor = async (step: string, pending: Promise<unknown> | null | undefined): Promise<void> => {
      if (!pending) return;
      const slow = setTimeout(() => this.logger.warn({ event: "shutdown.waiting", step }, "shutdown is still waiting"), 5_000);
      slow.unref?.();
      try { await pending; } finally { clearTimeout(slow); }
    };
    await waitFor("start", this.startPromise?.catch(() => undefined));
    await waitFor("active_loop_start", this.activeLoopStarting);
    if (this.pullTimer) clearInterval(this.pullTimer);
    for (const watch of this.onComputerWatches.values()) clearInterval(watch);
    this.onComputerWatches.clear();
    if (this.turnActivityTimer) clearTimeout(this.turnActivityTimer);
    this.turnActivityTimer = null;
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.updates?.stop();
    if (this.muxTimer) clearInterval(this.muxTimer);
    if (this.cancellationTimer) clearInterval(this.cancellationTimer);
    await waitFor("cancellation_replay", this.cancellationReplay?.stop());
    if (this.configurationTimer) clearInterval(this.configurationTimer);
    await waitFor("configuration_refresh", this.configurationRefresh);
    await waitFor("observation_delivery", this.observationDelivery?.stop());
    await waitFor("configuration_acks", this.configurationAcks?.settle());
    await waitFor("fence_receipts", this.executionRevisionFenceReceipts?.settle());
    await waitFor("planning_directives", this.planningDirectivePoller?.stop());
    this.heartbeat?.stop();
    await waitFor("heartbeat", this.heartbeat?.settle());
    await waitFor("lease_acquisition", this.leaseAcquisition);
    await waitFor("lease_mutation", this.leaseMutation);
    await waitFor("lease_loss_cleanup", this.leaseLossCleanup);
    await note("supervisor_prelude", "completed");
    await note("work_drain", "entered");
    // stop() withdrew this process's recovery authority first, so a session
    // whose close asserts it is refused ("Transport recovery generation is not
    // currently accepted"). That must not abort the stop before the runners
    // and the Codex owner below are stopped (D113: it orphaned Codex and no
    // receipt was written); the session stays journaled for recovery.
    try {
      await this.work?.drainSessions("drain");
      await note("work_drain", "completed");
    } catch (error) {
      this.logger.warn({ event: "shutdown.session_close_unconfirmed", code: error instanceof RemoteInstanceError ? error.code : "unexpected_error" },
        "an open session could not close during shutdown; stopping its agent anyway, the next start recovers it");
    }
    await note("preview_close", "entered");
    await this.previews.close();
    await note("preview_close", "completed");
    this.previewChannel?.dispose();
    await note("runner_stop", "entered");
    // Side by side: one after another, an idle connector's bridges took 5 s,
    // and launchd's SIGKILL came before the Codex owner was reached (D113b).
    // A runner that cannot stop does not keep the others, the Codex owner or
    // the state from stopping; its failure is reported once all are done.
    const runnerStops = await Promise.allSettled(this.nativeRunners.map(runner => runner.stop()));
    const runnerFailure = runnerStops.find((stop): stop is PromiseRejectedResult => stop.status === "rejected");
    const codexUnstopped = runnerStops.some((stop, index) => stop.status === "rejected" && this.nativeRunners[index]?.agentId === "codex");
    if (!runnerFailure) await note("runner_stop", "completed");
    await note("codex_owner_stop", "entered");
    // The shared Codex app-server is stopped here only once every Codex runner
    // stopped; otherwise the exit reaper armed by stop() ends it with the process.
    let codexFailure: { reason: unknown } | null = null;
    if (!codexUnstopped) await this.nativeCodexOwner?.stop().catch((reason: unknown) => { codexFailure = { reason }; });
    if (!codexFailure && !codexUnstopped) await note("codex_owner_stop", "completed");
    if (this.codexRetryTimer) clearTimeout(this.codexRetryTimer);
    this.codexRetryTimer = null;
    this.parkedCodex = null;
    this.nativeAgentRetry.stop();
    for (const runner of this.parkedRunners.values()) await runner.stop().catch(() => undefined);
    this.parkedRunners.clear();
    for (const runner of this.runners.values()) runner.stopEvents();
    this.transport?.stop();
    await note("state_close", "entered");
    await this.stateMutations.close();
    this.nativeOwnership?.release();
    if (runnerFailure) throw runnerFailure.reason;
    if (codexFailure) throw (codexFailure as { reason: unknown }).reason;
  }

  /**
   * A release an update just started is on probation until the update keeps
   * it: the ledger's attempt for this release is no longer in progress. An
   * attempt older than the update coordinator's stale bound is abandoned (its
   * updater died) and ends the probation too.
   */
  private async beginUpdateProbation(): Promise<void> {
    const probation = this.options.native?.updateProbation;
    if (!probation) return;
    const staleMs = probation.staleAttemptMs ?? 45 * 60_000;
    const checking = async (): Promise<boolean> => {
      const ledger = await probation.readLedger().catch(() => null);
      return ledger?.attempts.some(attempt => attempt.outcome === "in_progress" && attempt.releaseId === probation.releaseId &&
        Date.now() - Date.parse(attempt.startedAt) < staleMs) ?? false;
    };
    if (!await checking()) return;
    this.onUpdateProbation = true;
    this.logger.info({ event: "update.probation_started", releaseId: probation.releaseId }, "an update is checking this release; it takes no new work until the update keeps it");
    let reading = false;
    this.probationTimer = setInterval(() => {
      if (reading) return;
      reading = true;
      void checking().then(still => {
        if (still || !this.onUpdateProbation) return;
        this.onUpdateProbation = false;
        if (this.probationTimer) clearInterval(this.probationTimer);
        this.probationTimer = null;
        this.logger.info({ event: "update.probation_ended", releaseId: probation.releaseId }, "the update is done with this release; taking work");
      }).finally(() => { reading = false; });
    }, probation.pollMs ?? 2_000);
    this.probationTimer.unref();
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

function mapLoginEvent(loginId: string, event: { type: string; text?: string | undefined; url?: string | undefined; userCode?: string | undefined; label?: string | undefined; secret?: boolean | undefined; visible?: true | undefined; readiness?: string | undefined; code?: string | undefined; message?: string | undefined; reason?: "no_license" | undefined }): ControlLoginEvent {
  switch (event.type) {
    case "display":
      return { kind: "display", loginId, text: event.text ?? "" };
    case "open_url":
      return { kind: "open_url", loginId, url: event.url ?? "", ...(event.userCode ? { userCode: event.userCode } : {}) };
    case "prompt":
      return { kind: "prompt", loginId, label: event.label ?? "", secret: event.secret ?? true, ...(event.visible === true && event.secret === false ? { visible: true as const } : {}) };
    case "completed":
      return { kind: "completed", loginId, readiness: event.readiness ?? "unknown" };
    default:
      return { kind: "failed", loginId, code: event.code ?? "agent_auth_required", message: event.message ?? "login failed", ...(event.reason === "no_license" ? { reason: "no_license" as const } : {}) };
  }
}
