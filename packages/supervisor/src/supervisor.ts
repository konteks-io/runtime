import { runRequestedSkillSync } from "./native/requested-skill-sync.js";
import { refreshMachineSkills, machineSkillHomes, MachineSkillPartialFailure, type MachineSkillInventory } from "./native/skill-refresh.js";
import { SkillSyncCoordinator } from "./skills/sync-coordinator.js";
import { NativeSkillSyncClient } from "./native/skill-sync-client.js";
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
  REMOTE_RUNTIME_UPDATE_CAPABILITY,
  REMOTE_DIRECT_MODEL_FALLBACK_MIN_CORE_CONTRACT_VERSION,
  allEqual,
  SystemClock,
  createLogger,
  parseRfc3339,
  signBody,
  type AgentTurnUsageObservation,
  type ControlAck,
  type ControlEmitter,
  type ControlHandler,
  type ControlRequest,
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
import { RelayClient, type RelayClientOptions } from "./relay/relay-client.js";
import type { RunnerPort } from "./runner-port.js";
import { NativeRunner, type NativeRunnerOptions } from "./native/runner.js";
import { ModelCapabilitySnapshotProducer, antigravityOptionBilling, openCodeOptionBilling } from "./native/model-capability-snapshot.js";
import { NativeInventoryCollector, machineHasDesktop } from "./native/inventory.js";
import { windowsInstalledLauncher } from "./native/windows-launcher.js";
import { antigravityRunnerCapabilities, openCodeRunnerCapabilities, siteLoginRelay } from "./native/site-login.js";
import { ON_COMPUTER_AGENTS, canOpenOnComputer, onComputerDone, onComputerScript, openOnComputer, planOnComputer, readOnComputerWatches, releaseLauncher, removeOnComputerWatch, standInTerminalEnv, writeOnComputerWatch, type OnComputerAgent, type OnComputerPlan, type OnComputerWatch } from "./native/on-computer.js";
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
import { SupervisorJournal, type JournalEntry } from "./state/journal.js";
import type { RuntimeRecoveryRecord } from "./state/runtime-recovery.js";
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
import { RuntimeUpdateReceiver, type RuntimeUpdateScope } from "./native/runtime-update.js";
import { RuntimeUpdateStore } from "./native/runtime-update-store.js";
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
/** A turn's start or end is told to Core this soon, not at the next 30 s heartbeat. */
const TURN_ACTIVITY_HEARTBEAT_MS = 500;
const LIVENESS_MIN_BUDGET_MS = 5 * 60_000;
/**
 * How long Core may keep refusing this runtime's lapsed lease (Core answers,
 * the lease is gone) before the service restarts into its startup reconnect,
 * which proves the machine key and gets a fresh lease. Nothing else renews a
 * lapsed lease in a running process.
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
    /** Host agents the installation lists but could not find or verify at load; left out and retried. */
    unavailableAgents?: NativeUnavailableAgent[];
    /** The connector's QA browser; resolved from the runners' packages and the person's Node when absent (tests pass it). */
    browser?: ConnectorBrowserStatus;
    /** Test/embedding seam for the independently supervised shared Codex owner. */
    codexAppServerOptions?: Omit<NativeCodexAppServerOwnerOptions, "config">;
    /** Self-update policy; absent means the connector only reports `update_required`. */
    update?: Pick<NativeUpdateCoordinatorOptions, "fetchManifest" | "launch" | "readLedger" | "checkIntervalMs" | "initialDelayMs" | "maxAttemptsPerRelease" | "attemptWindowMs" | "staleAttemptMs">;
    /**
     * This release and the update ledger: while an update is still checking
     * this release (its health gate), it takes no new work, so a rollback
     * never stops it under a claim.
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
  private skillSyncClient: NativeSkillSyncClient | undefined;
  private skillSync: SkillSyncCoordinator<MachineSkillInventory> | undefined;
  /** Runs `integration` work; composed with the native runners. */
  private integrationCarrier: IntegrationWorkCarrier | undefined;
  private roleBindings: RoleBinding[] = [];
  private draining = false;
  /** An update is still checking this release; no new work until it keeps it. */
  private onUpdateProbation = false;
  private probationTimer: NodeJS.Timeout | null = null;
  private drainReason: string | null = null;
  /** Non-null only for a Core directive; the local operator cannot lift that one. */
  private drainDeadline: string | null = null;
  private pendingRevocation = false;
  private lastSnapshot: InventorySnapshot | null = null;
  /** This release's `konteks-remote` commands at its bundle version, built once; null when the table or version does not parse. */
  private connectorCommandsCache: { manifest: ConnectorCommandsManifest | null } | null = null;
  private connectorCommands(): ConnectorCommandsManifest | undefined {
    this.connectorCommandsCache ??= { manifest: connectorCommandsManifest(this.config.SUPERVISOR_BUNDLE_VERSION) };
    return this.connectorCommandsCache.manifest ?? undefined;
  }
  /** The cached detection of supported agents the installation does not list. */
  private notAddedAgents: NotAddedAgentsDetector | null = null;
  /**
   * The machine's own git. It is a field rather than a dependency
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
  /** The QA browser every agent's sessions get, or why this connector has none. */
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
  private runtimeUpdates: RuntimeUpdateReceiver | null = null;
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
      onUnavailable: sessionId => this.previewChannel?.previewUnavailable(sessionId),
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
    const native = this.options.native;
    if (!native) throw new RemoteInstanceError("protocol_incompatible", "Native supervisor composition requires explicit native dependencies.");
    await this.openNativeState();
    const identity = await this.loadActivation(native);
    await this.restoreStoredLease(identity.instanceId);
    this.composeCoreDeliveries();
    await this.composeLocalAgents(native, identity.instanceId);
    this.composeInventory(native);
    this.composeModelCapabilities();
    await this.composeMux();
    const verifier = new CoreSignatureVerifier(this.roots);
    this.relay = this.config.SUPERVISOR_RELAY_URL ? this.createRelayClient(this.config.SUPERVISOR_RELAY_URL, verifier) : null;
    this.composeTransport();
    await this.composeControl(verifier);
    this.composeWork(native, verifier);
    this.composeRecovery(verifier);
    this.composeHeartbeat();
    await this.startLocalAgents(native);
    this.lastSnapshot = await this.inventory.collect();
    if (this.stopping) return;
    await this.enterLifecycle();
    this.startChannelTimers();
  }

  /** Take the state directory, sweep leftover previews and load the journals. */
  private async openNativeState(): Promise<void> {
    this.nativeOwnership = acquireNativeRootLock(this.config.SUPERVISOR_DATA_DIR, { onLost: () => {
      this.logger.error("native state ownership lost; stopping without reacquisition");
      void this.stop().catch(() => this.logger.error("native ownership-loss shutdown failed"));
    } });
    await this.store.init();
    // A restart never adopts a preview: kill what a crashed process left running.
    await this.previewRegistry.sweep();
    await this.journal.load();
    await this.outbox.load();
    await this.beginUpdateProbation();
  }

  /**
   * A native machine that has an identity but no key has lost the only proof
   * of who it is. A fresh key would be refused by Core on every call while
   * the process looked alive, so it stops and says so; `konteks-remote
   * onboard` connects the machine again as a new runtime.
   */
  private async loadInstanceKey(): Promise<void> {
    const knownIdentity = await this.store.identity().catch(() => null);
    const existingKey = knownIdentity ? await this.store.loadInstanceKey() : null;
    if (knownIdentity && !existingKey) {
      throw new RemoteInstanceError("install_state_corrupt", MACHINE_KEY_LOST);
    }
    this.key = existingKey ?? (await this.store.loadOrCreateInstanceKey());
  }

  /** The stored activation, with its signed release verified against the installed one. */
  private async loadActivation(native: NativeOptions): Promise<StoredIdentity> {
    await this.loadInstanceKey();
    this.roots = (native.trustedRoots ?? []).map(root => EmbeddedReleaseRootSchema.parse(root));
    const identity = await this.store.identity();
    const manifest = await this.store.manifest();
    this.adoptIdentity(identity);
    this.manifestDigest = manifest?.manifestDigest ?? "";
    if (!identity || !manifest) throw new RemoteInstanceError("install_state_corrupt", "Native activation and release state are required before startup.");
    await this.verifyInstalledRelease(native, manifest);
    return identity;
  }

  private adoptIdentity(identity: StoredIdentity | null): void {
    this.instanceId = identity?.instanceId ?? null;
    this.workspaceId = identity?.workspaceId ?? null;
    this.administrativeStatus = identity?.administrativeStatus ?? "unknown";
  }

  private async verifyInstalledRelease(native: NativeOptions, manifest: StoredManifest): Promise<void> {
    try {
      this.nativeRelease = verifyNativeRelease(JSON.parse(await readFile(this.config.SUPERVISOR_RELEASE_MANIFEST_FILE, "utf8")), this.roots, this.clock.now());
      const exchange = verifyNativeRelease(manifest.manifest, this.roots, this.clock.now());
      if (manifest.manifestDigest !== exchange.manifest.digest || this.nativeRelease.manifest.bundleVersion !== this.config.SUPERVISOR_BUNDLE_VERSION) throw new Error("release mismatch");
      await verifyInstalledNativeBridges(this.nativeRelease, native.runners, { os: this.config.SUPERVISOR_PLATFORM_OS, architecture: this.config.SUPERVISOR_PLATFORM_ARCH });
      if (manifest.manifestDigest !== this.nativeRelease.manifest.digest) {
        // Release evolution can be interrupted after the immutable successor
        // and runtime record advance but before this projection. Only a
        // strictly newer independently verified installed release may repair
        // it; downgrade and same-version digest substitution refuse.
        if (compareSemver(this.nativeRelease.manifest.bundleVersion, exchange.manifest.bundleVersion) <= 0) throw new Error("release projection mismatch");
        await this.store.saveManifest(this.nativeRelease.manifest, this.nativeRelease.manifest.digest);
      }
      this.manifestDigest = this.nativeRelease.manifest.digest;
    } catch { throw new RemoteInstanceError("bundle_untrusted", "Native startup requires matching signed activation and installed release artifacts."); }
  }

  /** A stored lease is adopted only when it belongs to this workspace and its metadata matches its decoded claims. */
  private async restoreStoredLease(instanceId: string): Promise<void> {
    const storedLease = await this.store.lease();
    if (!storedLease) return;
    const claims = decodeStoredLeaseClaims(storedLease.lease, { instanceId, audience: LEASE_AUDIENCE });
    if (claims.workspace_id !== this.workspaceId || storedLease.workspaceId !== this.workspaceId) throw new RemoteInstanceError("registration_mismatch", "lease workspace does not match the native activation");
    if (!sameLeaseRecord(storedLease, leaseRecordFromClaims(storedLease.lease, claims))) {
      throw new RemoteInstanceError("registration_mismatch", "stored lease metadata does not match its decoded claims");
    }
    this.lease.set(storedLease);
    this.workspaceId = storedLease.workspaceId;
  }

  private composeCoreDeliveries(): void {
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
  }

  private async composeLocalAgents(native: NativeOptions, instanceId: string): Promise<void> {
    const sharedCodex = native.runners.find(config => config.RUNNER_AGENT_ID === "codex" && config.RUNNER_NATIVE_CODEX_SOCKET !== undefined);
    if (sharedCodex) this.nativeCodexOwner = new NativeCodexAppServerOwner({
      ...native.codexAppServerOptions,
      config: sharedCodex,
      onRestartFailure: error => this.logger.warn({ err: error }, "shared Codex app-server restart failed; retrying"),
    });
    // The QA browser is the connector's, not an agent package's: every
    // agent's sessions get it when an installed Claude Code or Codex package
    // carries it and some Node can run it.
    this.connectorBrowser = native.browser ?? (await resolveConnectorBrowser(native.runners));
    if (this.connectorBrowser.available) {
      this.logger.info({ event: "browser.connector_ready", packageAgent: this.connectorBrowser.browser.packageAgent, nodeSource: this.connectorBrowser.browser.nodeSource }, "the QA browser is available to every agent on this computer");
    } else {
      this.logger.warn({ event: "browser.connector_unavailable", reason: this.connectorBrowser.reason }, this.connectorBrowser.message);
    }
    this.nativeRunnerInstanceId = instanceId;
    for (const config of withConnectorBrowser(native.runners, this.connectorBrowser)) {
      const runner = this.createNativeRunner(config);
      this.nativeRunners.push(runner);
      this.runners.set(runner.agentId, runner);
    }
    // Integration tasks (discovery, setup, gated
    // read/write/verify sessions) on this computer's Claude Code and Codex.
    this.integrationCarrier = composeIntegrationCarrier({
      configs: native.runners,
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
  }

  private composeInventory(native: NativeOptions): void {
    // The personal Claude Code executable a claude-code runner runs: its
    // version and digest ride the capabilities.
    const claudeExecutable = native.runners.find(runner => runner.RUNNER_AGENT_ID === "claude-code")?.RUNNER_NATIVE_CLAUDE_EXECUTABLE;
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
      // A site-started login needs a native install with a Codex runner.
      agentLoginReady: () => this.runners.has("codex") && !this.stopping && this.relay !== null && this.relay !== undefined,
      agentLoginBrowserReady: () => this.runners.has("claude-code") && !this.stopping && this.relay !== null && this.relay !== undefined && machineHasDesktop(),
      additionalCapabilities: () => [...this.openCodeCapabilities(), ...this.antigravityCapabilities(), ...this.onComputerCapabilities(), ...(this.browserToolReady() ? [BROWSER_TOOL_CAPABILITY] : []),
        ...(this.integrationCarrier ? integrationTaskCapabilities(this.runners.keys()) : []), ...this.runtimeUpdateCapabilities()],
      decorateAgents: agents => this.withAntigravityDownload(agents),
      skillSyncReady: () => this.skillSyncReady(),
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
  }

  private composeModelCapabilities(): void {
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
      // OpenCode's routes bill by provider and credential; only a
      // 7.1.0 Core takes the field (the shape is strict and digested).
      optionBilling: (agentId, value, agent) =>
        !this.hostSettings.coreAcceptsRouteBilling ? undefined
        : agentId === "opencode" ? openCodeOptionBilling(agent, value) : agentId === "antigravity" ? antigravityOptionBilling(agent) : undefined,
    });
  }

  private async composeMux(): Promise<void> {
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
      // This callback selects the retained assignment carrier, even before a sender
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
    // answer out of sequence after an update. They start fresh.
    const durableChannelOf = (channelId: string) => {
      const channel = channelOf(channelId);
      return channel === "preview" ? null : channel;
    };
    if (relayState) this.mux.restoreDurableState(relayState, durableChannelOf);
    else this.mux.restoreCursors(await this.store.cursors(), durableChannelOf);
    if (this.instanceId) this.openCoreChannels(this.instanceId);
  }

  private createRelayClient(relayUrl: string, verifier: CoreSignatureVerifier): RelayClient {
    return new RelayClient({
      relayUrl,
      instanceId: () => this.instanceId ?? "",
      runnerIncarnation: () => this.runnerIncarnation,
      appliedManifestId: () => this.recoveryAuthority() ? (this.journal.recovery.current(this.instanceId ?? "", this.runnerIncarnation)?.manifest?.manifestId ?? null)
          : null,
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
      onRuntimeUpdate: (request, connection) => this.receiveRuntimeUpdate(request, connection, verifier),
      onPermissionAnswer: (request, connection) => this.receivePermissionAnswer(request, connection, verifier),
      onCancellation: (request, connection) => this.receiveCancellation(request, connection, verifier),
      onDiagnosticCompanion: (request, connection) => this.receiveDiagnosticCompanion(request, connection, verifier),
      onExecutionRevisionControl: (request, connection) => this.receiveExecutionRevisionControl(request, connection, verifier),
        });
  }

  private async receivePermissionAnswer(request: RelayRequestOf<"onPermissionAnswer">, connection: RelayConnectionOf<"onPermissionAnswer">, verifier: CoreSignatureVerifier): Promise<void> {
    const producer = this.config.SUPERVISOR_CORE_PERMISSION_ANSWER_PRODUCER;
    if (!producer) throw new RemoteInstanceError("recovery_required", "Core answer producer is not configured");
    const owner = this.captureOwner();
    const accepted = this.recoveryAuthority();
    const { lease, instanceId, workspaceId, runnerIncarnation, ownership } = owner;
    const receiver = new PermissionAnswerReceiver({
      verifier, core: this.core, coreProducer: producer, now: () => this.clock.coreNow(),
      deliver: (operation, claims, guard) => this.work.onPermissionAnswer(operation, claims, guard),
      captureConnection: () => lease && instanceId && workspaceId && ownership && accepted ? {
        instanceId, workspaceId, runnerIncarnation, connectionEpoch: connection.connectionEpoch, leaseExpiresAt: lease.expiresAt,
        assertCurrent: () => {
          connection.assertCurrent();
          if (!this.ownerUnchanged(owner) || this.recoveryAuthority() !== accepted || !this.lease.canPullNewWork()) {
            throw new RemoteInstanceError("recovery_required", "Answer execution ownership is not current");
          }
          ownership.assertOwned();
        },
      } : null,
    });
    await receiver.receive(request);
  }

  private async receiveCancellation(request: RelayRequestOf<"onCancellation">, connection: RelayConnectionOf<"onCancellation">, verifier: CoreSignatureVerifier): Promise<void> {
    const owner = this.captureOwner();
    const { lease, instanceId, workspaceId, runnerIncarnation, ownership } = owner;
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
          if (!this.ownerUnchanged(owner)) throw new RemoteInstanceError("recovery_required", "Cancellation native ownership is not current");
          ownership.assertOwned();
        },
      } : null,
    });
    await receiver.receive(request);
  }

  private async receiveDiagnosticCompanion(request: RelayRequestOf<"onDiagnosticCompanion">, connection: RelayConnectionOf<"onDiagnosticCompanion">, verifier: CoreSignatureVerifier): Promise<void> {
    const owner = this.captureOwner();
    const { lease, instanceId, workspaceId, runnerIncarnation, ownership } = owner;
    const receiver = new DiagnosticCompanionReceiver({
      verifier,
      inbox: this.journal.diagnosticCompanions,
      now: () => this.clock.coreNow(),
      onAccepted: record => this.onDiagnosticCompanionAccepted(record),
      captureConnection: () => lease && instanceId && workspaceId && ownership ? {
        instanceId,
        workspaceId,
        runnerIncarnation,
        nodeId: request.nodeId,
        connectionRef: request.connectionRef,
        connectionEpoch: connection.connectionEpoch,
        assertCurrent: () => {
          connection.assertCurrent();
          if (!this.ownerUnchanged(owner)) throw new RemoteInstanceError("recovery_required", "Diagnostic companion ownership is not current");
          ownership.assertOwned();
        },
      } : null,
    });
    await receiver.receive(request);
  }

  /** Log a persisted diagnostic companion against the active operation it matches, if any. */
  private onDiagnosticCompanionAccepted(record: DiagnosticCompanionRecord): void {
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
  }

  private async receiveExecutionRevisionControl(request: RelayRequestOf<"onExecutionRevisionControl">, connection: RelayConnectionOf<"onExecutionRevisionControl">, verifier: CoreSignatureVerifier): Promise<void> {
    const owner = this.captureOwner();
    const accepted = this.recoveryAuthority();
    const { lease, instanceId, workspaceId, runnerIncarnation, ownership } = owner;
    const assertCurrent = () => {
      connection.assertCurrent();
      if (!lease || !instanceId || !workspaceId || !ownership || !this.ownerUnchanged(owner) || this.recoveryAuthority() !== accepted) {
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
  }

  /** The lease, identity, incarnation and state ownership a relayed request arrived under. */
  private captureOwner(): CapturedOwner {
    return { lease: this.lease.current(), instanceId: this.instanceId, workspaceId: this.workspaceId,
      runnerIncarnation: this.runnerIncarnation, ownership: this.nativeOwnership };
  }

  /** Not stopping, and still the same state ownership, lease, identity and incarnation. */
  private ownerUnchanged(owner: CapturedOwner): boolean {
    return (
      !this.stopping && this.nativeOwnership === owner.ownership && this.lease.current() === owner.lease &&
      this.instanceId === owner.instanceId && this.workspaceId === owner.workspaceId && this.runnerIncarnation === owner.runnerIncarnation
    );
  }

  private receiveRuntimeUpdate(request: RelayRequestOf<"onRuntimeUpdate">, connection: RelayConnectionOf<"onRuntimeUpdate">, verifier: CoreSignatureVerifier): Promise<void> {
    const scope = this.runtimeUpdateScope(connection);
    const receiver = this.ensureRuntimeUpdates(verifier);
    if (!scope || !receiver) throw new RemoteInstanceError("recovery_required", "Runtime update ownership is unavailable.");
    return receiver.receive(request, scope);
  }

  private runtimeUpdateScope(connection: RelayConnectionOf<"onRuntimeUpdate">): RuntimeUpdateScope | null {
    const owner = this.captureOwner();
    const accepted = this.recoveryAuthority();
    if (!owner.lease || !owner.instanceId || !owner.workspaceId || !accepted) return null;
    const claims = decodeLeaseClaims(owner.lease.lease, { instanceId: owner.instanceId, audience: LEASE_AUDIENCE });
    return { instanceId: owner.instanceId, tenantId: owner.workspaceId, leaseId: claims.jti,
      runnerIncarnation: owner.runnerIncarnation, connectionEpoch: connection.connectionEpoch, leaseExpiresAt: owner.lease.expiresAt,
      assertCurrent: () => this.assertRuntimeUpdateOwner(owner, accepted, claims, connection) };
  }

  private assertRuntimeUpdateOwner(owner: CapturedOwner, accepted: string, claims: ReturnType<typeof decodeLeaseClaims>, connection: RelayConnectionOf<"onRuntimeUpdate">): void {
    connection.assertCurrent();
    if (claims.lease_mode !== "active" || claims.administrative_status !== "active") {
      throw new RemoteInstanceError("recovery_required", "Runtime update admission requires an active owner.");
    }
    this.assertRuntimeUpdateAuthority(owner, accepted, claims);
  }

  private assertRuntimeUpdateAuthority(owner: CapturedOwner, accepted: string, claims: ReturnType<typeof decodeLeaseClaims>): void {
    if (!this.runtimeUpdateOwnerUnchanged(owner) || !this.runtimeUpdateLeaseUnchanged(owner, claims) || this.recoveryAuthority() !== accepted) {
      throw new RemoteInstanceError("recovery_required", "Runtime update ownership is no longer current.");
    }
    owner.ownership?.assertOwned();
  }

  /** Update admission may span normal heartbeats; its process and root may not change. */
  private runtimeUpdateOwnerUnchanged(owner: CapturedOwner): boolean {
    return !this.stopping && owner.ownership !== null && this.nativeOwnership === owner.ownership &&
      this.instanceId === owner.instanceId && this.workspaceId === owner.workspaceId && this.runnerIncarnation === owner.runnerIncarnation;
  }

  /** Only a usable renewal of the captured policy can retain update/report ownership. */
  private runtimeUpdateLeaseUnchanged(owner: CapturedOwner, captured: ReturnType<typeof decodeLeaseClaims>): boolean {
    const current = this.lease.current();
    if (!current || !owner.instanceId || !this.leaseUsable()) return false;
    const claims = decodeLeaseClaims(current.lease, { instanceId: owner.instanceId, audience: LEASE_AUDIENCE });
    if (!sameLeaseRecord(current, leaseRecordFromClaims(current.lease, claims)) || current.workspaceId !== owner.workspaceId) return false;
    return sameRuntimeUpdateLeasePolicy(captured, claims);
  }

  private captureRuntimeUpdateReportOwner(): () => void {
    const owner = this.captureOwner();
    const accepted = this.recoveryAuthority();
    if (!accepted || !owner.lease || !owner.instanceId) throw new RemoteInstanceError("recovery_required", "Runtime update reporting ownership is unavailable.");
    const claims = decodeLeaseClaims(owner.lease.lease, { instanceId: owner.instanceId, audience: LEASE_AUDIENCE });
    const assertCurrent = () => this.assertRuntimeUpdateAuthority(owner, accepted, claims);
    assertCurrent();
    return assertCurrent;
  }

  private runtimeUpdateCapabilities(): string[] {
    if (!this.options.native?.update || !this.relay || !this.recoveryAuthority()) return [];
    return new CoreSignatureVerifier(this.roots).configured ? [REMOTE_RUNTIME_UPDATE_CAPABILITY] : [];
  }

  private ensureRuntimeUpdates(verifier = new CoreSignatureVerifier(this.roots)): RuntimeUpdateReceiver | null {
    const update = this.options.native?.update;
    if (!update || !verifier.configured) return null;
    this.runtimeUpdates ??= new RuntimeUpdateReceiver({
      verifier,
      store: new RuntimeUpdateStore(this.store.path("runtime-updates.json"), this.stateMutations.run),
      coordinator: () => this.ensureUpdates(),
      now: () => this.clock.coreNow(),
      proof: () => ({ bundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION, manifestDigest: this.manifestDigest,
        runnerIncarnation: this.runnerIncarnation, ready: this.nativeRelease !== null && !this.onUpdateProbation && this.recoveryAuthority() !== null }),
      readLedger: update.readLedger,
      captureReportOwner: () => this.captureRuntimeUpdateReportOwner(),
      report: report => this.core.reportRuntimeUpdate(this.instanceId!, report),
    });
    return this.runtimeUpdates;
  }

  private composeTransport(): void {
    // The retained-stream cutover is decided by the protocol this build speaks, not by
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
  }

  private async composeControl(verifier: CoreSignatureVerifier): Promise<void> {
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
  }

  private composeWork(native: NativeOptions, verifier: CoreSignatureVerifier): void {
    this.broker = new PermissionBroker({ clock: this.clock, deadlineSeconds: () => this.configuration.permissionResponderDeadlineSeconds, onTimeout: async (request) => this.work.onPermissionTimeout(request) });
    this.work = new WorkOrchestrator({
      verifyCancellation: directive => verifier.verify(directive, directive.signature),
      onSessionReleased: async sessionId => {
        // The dev server stops with the session; its worktree stays openable
        // by a viewer while it exists (a delivery's preview after the delivery).
        this.previewViewerStarts.delete(sessionId);
        await this.previews.stop(sessionId, "session_released");
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
        roots: native.runners.map(config => config.RUNNER_WORKSPACE_DIR),
        journal: this.journal,
        mutate: this.stateMutations.run,
        logger: this.logger,
        client: () => new NativeOutputClient({
          baseUrl: this.config.SUPERVISOR_CORE_URL, clock: this.clock,
          credential: () => this.lease.mode() === "active" ? (this.lease.current()?.lease ?? null) : null,
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
        directModelSelectionSupported: () =>
          coreContractAtLeast(
            this.coreContractVersion,
            REMOTE_DIRECT_MODEL_FALLBACK_MIN_CORE_CONTRACT_VERSION,
          ),
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
        workspaceRoot: native.runners.find(config => config.RUNNER_AGENT_ID === runner.agentId)!.RUNNER_WORKSPACE_DIR,
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
          directModelSelectionSupported: () =>
            coreContractAtLeast(
              this.coreContractVersion,
              REMOTE_DIRECT_MODEL_FALLBACK_MIN_CORE_CONTRACT_VERSION,
            ),
          assertActive: () => {
            if (this.stopping || !this.nativeOwnership || this.lease.mode() !== "active") throw new RemoteInstanceError("capability_unavailable", "Native readiness requires an active owned instance.");
            this.nativeOwnership.assertOwned();
          },
        }),
        prepareInputs: native.prepareInputs ?? createNativeInputPreparer({
          logger: this.logger,
          root: native.runners.find(config => config.RUNNER_AGENT_ID === runner.agentId)!.RUNNER_WORKSPACE_DIR,
          clock: this.clock,
          mutate: this.stateMutations.run,
          ...(native.git ? { git: native.git } : {}),
          ...(native.repositoryCacheRoot
            ? { repositoryCacheRoot: native.repositoryCacheRoot }
            : {}),
          ...(native.prepareRepositoryWorktree
            ? { prepareRepositoryWorktree: native.prepareRepositoryWorktree }
            : {}),
          client: () => new NativeInputClient({
            baseUrl: this.config.SUPERVISOR_CORE_URL, roots: this.roots, clock: this.clock,
            credential: () => this.lease.mode() === "active" ? (this.lease.current()?.lease ?? null) : null,
          }),
          outputClient: () => new NativeOutputClient({
            baseUrl: this.config.SUPERVISOR_CORE_URL, clock: this.clock,
            credential: () => this.lease.mode() === "active" ? (this.lease.current()?.lease ?? null) : null,
          }),
          claimId: target => this.activeClaimId(target),
        }),
      }),
      onUsage: (observation) => this.sendUsageObservation(observation),
    });
  }

  /** The claim of an active, unexpired assignment this owned, active process holds for `target`; null otherwise. */
  private activeClaimId(target: RemoteWorkAssignment): string | null {
    const ownership = this.activeOwnershipFor(target);
    if (!ownership) return null;
    ownership.assertOwned();
    const entry = this.journal.assignments.get(target.id + ":" + target.attempt);
    if (!entry || !claimMatchesTarget(entry, target)) return null;
    return Date.parse(entry.expiresAt) <= this.clock.coreNow() ? null : entry.claimId;
  }

  /** The state ownership of an active lease while not stopping, when `target` names this instance and workspace. */
  private activeOwnershipFor(target: RemoteWorkAssignment): NonNullable<Supervisor["nativeOwnership"]> | null {
    if (this.stopping || !this.nativeOwnership || this.lease.mode() !== "active") return null;
    return target.instanceId === this.instanceId && target.workspaceId === this.workspaceId ? this.nativeOwnership : null;
  }

  private composeRecovery(verifier: CoreSignatureVerifier): void {
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

  }

  private composeHeartbeat(): void {
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
      onInventory: (snapshot) => {
        this.lastSnapshot = snapshot;
        this.modelCapabilities?.invalidateForAgents(snapshot.agents);
        void this.modelCapabilities?.refresh(snapshot.agents).catch(error => this.logger.warn({ err: error }, "native model capability refresh failed"),
          );
      },
      roleBindings: () => this.roleBindings,
      activeAssignmentIds: () => this.work.activeAssignmentIds(),
      modelCapabilitySnapshots: () => this.modelCapabilities?.snapshots() ?? [],
      supportedAgents: agents => this.supportedAgents(agents),
      // The commands this release carries, only to a Core that takes 7.1 fields.
      connectorCommands: () =>
        this.hostSettings.coreAcceptsRouteBilling ? this.connectorCommands() : undefined,
      configRevision: () => this.control.configRevision,
      bundleVersion: this.config.SUPERVISOR_BUNDLE_VERSION,
      softMaxConcurrent: () => this.configuration.softMaxConcurrent ?? this.config.SUPERVISOR_SOFT_MAX_CONCURRENT,
      acceptingWork: () => !this.draining && !this.onUpdateProbation && this.lease.canPullNewWork() && this.reconciliation.isComplete,
      intervalSeconds: () => this.heartbeatIntervalSeconds ?? this.configuration.heartbeatIntervalSeconds,
      renewalDelayMs: () => (this.lease.current() ? this.lease.nextRenewalDelayMs() : 5000),
    });
  }

  private async startLocalAgents(native: NativeOptions): Promise<void> {
    for (const runner of this.runners.values()) runner.startEvents();
    const agents = await startNativeAgents({
      codexOwner: this.nativeCodexOwner,
      runners: this.nativeRunners,
      onUnavailable: (agentId, error) => {
        this.agentStartFailures.set(agentId, error);
        this.logger.error({ err: error, agentId }, "agent could not start; the runtime continues without it");
      },
    });
    if (this.nativeCodexOwner && !agents.codexOwnerStarted) this.parkFailedCodex(this.nativeCodexOwner);
    // Any other agent that could not start is left out the same way and
    // retried in the background, so one agent never takes the rest down.
    for (const runner of agents.failed) this.parkNativeRunner(runner);
    for (const entry of native.unavailableAgents ?? []) this.parkUnavailableHostAgent(entry);
  }

  /**
   * Codex is left out rather than taking every other agent down with it: it
   * is not advertised, so no work is placed on it. It is tried again in the
   * background, so a passing failure does not leave it out until the service
   * happens to restart.
   */
  private parkFailedCodex(owner: NativeCodexAppServerOwner): void {
    this.parkedCodex = { owner, runners: this.nativeRunners.filter(candidate => candidate.agentId === "codex") };
    this.scheduleCodexRetry();
    this.nativeCodexOwner = null;
    for (const runner of this.nativeRunners.filter(candidate => candidate.agentId === "codex")) this.runners.delete(runner.agentId);
    for (let index = this.nativeRunners.length - 1; index >= 0; index -= 1) {
      if (this.nativeRunners[index]!.agentId === "codex") this.nativeRunners.splice(index, 1);
    }
  }

  private async enterLifecycle(): Promise<void> {
    if (this.instanceId && this.administrativeStatus !== "provisioning") {
      await this.startActiveLoop();
    } else if (this.instanceId) {
      await this.continueProvisioning();
    } else {
      this.logger.warn("no instance identity yet; waiting for the launcher to run install");
    }
  }

  private startChannelTimers(): void {
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
    // Google Antigravity's update: its `relocate` fetches this release's
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
   * handshake knows whose endpoint cursor to ask.
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
    await this.provisioningTick();
  }

  private async provisioningTick(): Promise<void> {
    const current = await this.store.provisioning();
    if (!current) return void (this.provisioningLoopActive = false);
    if (parseRfc3339(current.provisioningWindowExpiresAt) <= this.clock.coreNow()) {
      this.provisioningLoopActive = false;
      this.logger.error("provisioning window expired; a fresh activation is required");
      return;
    }
    if (provisioningCredentialIsExpired(current, this.clock)) await this.refreshProvisioning();
    const snapshot = await this.inventory.collect();
    this.lastSnapshot = snapshot;
    const unhealthy = snapshot.components.filter((component) => component.healthStatus !== "healthy");
    if (unhealthy.length > 0) {
      // Provisioning waits for all four components. Silence here reads as a
      // hung install, so name what is still missing on every attempt.
      this.logger.info({ waitingFor: unhealthy.map((component) => `${component.kind}:${component.healthStatus}`) }, "provisioning is waiting for components to become healthy");
      setTimeout(() => void this.provisioningTick(), 10_000).unref();
      return;
    }
    await this.submitProvisioningReadiness(snapshot);
  }

  private async refreshProvisioning(): Promise<void> {
    await refreshProvisioningCredential({ store: this.store, core: this.core, clock: this.clock, logger: this.logger }).catch((error: unknown) => this.logger.warn({ err: error }, "provisioning refresh failed"));
    this.provisioningCredential = (await this.store.provisioning())?.provisioningCredential ?? null;
  }

  private async submitProvisioningReadiness(snapshot: InventorySnapshot): Promise<void> {
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
      setTimeout(() => void this.provisioningTick(), 15_000).unref();
    }
  }

  private startActiveLoop(): Promise<void> {
    if (this.stopping || this.activeLoopStarted) return Promise.resolve();
    if (this.activeLoopStarting) return this.activeLoopStarting;
    this.startLivenessWatchdog();
    stopTimeout(this.recoveryRetryTimer);
    this.recoveryRetryTimer = null;
    const operation = this.startActiveLoopImpl().catch(error => this.onActiveLoopFailed(error))
      .finally(() => { this.activeLoopStarting = null; });
    this.activeLoopStarting = operation;
    return operation;
  }

  private onActiveLoopFailed(error: unknown): void {
    // The logger keeps no stack, and every local-history refusal says the same
    // sentence: name where it came from, or a stuck recovery is undiagnosable.
    this.logger.warn({ err: error, ...stackField(error) }, "startup recovery remains pending");
    const terminal = recoveryEnded(this.journal.recovery.current(this.instanceId ?? "", this.runnerIncarnation));
    const retired = this.retiredByCore(error, terminal);
    this.reconnectRefusal = this.describeReconnectRefusal(error, retired);
    // Below Core's minimum no start can succeed: only an update gets back in.
    if (remoteErrorCodeIn(error, ["update_required"])) this.requestUpdateForRefusedBundle();
    if (retired && !this.stopping && !this.activeLoopStarted) this.restartForRetiredProcess(error);
    if (!terminal && !this.refusedForGood(error)) this.armRecoveryRetry();
  }

  /**
   * Core retired this process's recovery generation (or it expired, or
   * another establishment won): this incarnation can never be accepted
   * again, and retrying it is refused forever. A new process is a new
   * incarnation that establishes through the ordinary path, so restart.
   */
  private retiredByCore(error: unknown, terminal: boolean): boolean {
    return (
      this.administrativeStatus !== "revoked" && !remoteErrorCodeIn(error, REVOKED_CODES) &&
      (terminal || remoteErrorCodeIn(error, RETIRED_CODES))
    );
  }

  /** A revoked or retired runtime is never retried in place. */
  private refusedForGood(error: unknown): boolean {
    return (
      this.administrativeStatus === "revoked" || remoteErrorCodeIn(error, [...REVOKED_CODES, ...RETIRED_CODES])
    );
  }

  private armRecoveryRetry(): void {
    if (this.stopping || this.activeLoopStarted || this.recoveryRetryTimer) return;
    this.recoveryRetryTimer = setTimeout(() => { this.recoveryRetryTimer = null; void this.startActiveLoop(); }, 15_000);
    this.recoveryRetryTimer.unref();
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
    this.livenessTimer = setInterval(() => this.checkLiveness(), LIVENESS_CHECK_MS);
    this.livenessTimer.unref();
  }

  private checkLiveness(): void {
    if (this.stopping || !this.livenessTimer) return;
    if (this.leaseLapseNeedsRestart()) return this.restartForLapsedLease();
    const budgetMs = Math.max(LIVENESS_MIN_BUDGET_MS, this.heartbeat.livenessBudgetMs());
    const liveness = this.heartbeat.liveness();
    const verdict = evaluateHeartbeatLiveness({ now: Date.now(), watchingSince: this.livenessWatchingSince ?? Date.now(), liveness, budgetMs });
    if (verdict.state === "live") { this.livenessQuietWarned = false; return; }
    const detail = { ...verdict, budgetMs, heartbeat: liveness, activeLoopStarted: this.activeLoopStarted, activeLoopStarting: this.activeLoopStarting !== null,
      recoveryRetryArmed: this.recoveryRetryTimer !== null, leaseMode: this.lease.mode(), administrativeStatus: this.administrativeStatus,
      activeResources: process.getActiveResourcesInfo().slice(0, 32) };
    if (verdict.state === "quiet") return this.warnLivenessQuiet(detail);
    stopInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.logger.error(detail, "supervisor liveness lost: no heartbeat attempted within the budget; asking the service to restart");
    this.options.onLivenessLost?.(detail);
  }

  /** Warn once per quiet stretch. */
  private warnLivenessQuiet(detail: Record<string, unknown>): void {
    if (!this.livenessQuietWarned) this.logger.warn(detail, "no heartbeat attempted for a while; the supervisor may be stuck");
    this.livenessQuietWarned = true;
  }

  private restartForLapsedLease(): void {
    stopInterval(this.livenessTimer);
    this.livenessTimer = null;
    const detail = { reason: "lease_lapsed", leaseMode: this.lease.mode(), leaseExpiresAt: this.lease.current()?.expiresAt ?? null,
      refusedForMs: Date.now() - (this.leaseRefusedSince ?? Date.now()), administrativeStatus: this.administrativeStatus };
    this.logger.error(detail, "the lease lapsed and Core refuses it; restarting to reconnect with this machine's key");
    this.options.onLivenessLost?.(detail);
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
    if (await this.store.provisioning()) await this.adoptRecoveredProvisioning();
    if (this.instanceId) this.openCoreChannels(this.instanceId);
    await this.refreshConfiguration();
    if (this.stopping) return;
    this.requireRecoveryAuthority();
    await this.startOrdinaryLoops();
    if (this.stopping) return;
    this.requireRecoveryAuthority();
    this.activeLoopStarted = true;
    this.reconnectRefusal = null;
    this.beginActiveWork();
    this.requestAutomaticSkillSync();
    await this.work.reports.flushAll();
  }

  /** Readiness was committed but its response lost: the recovered identity ends provisioning. */
  private async adoptRecoveredProvisioning(): Promise<void> {
    this.requireRecoveryAuthority();
    const identity = await this.store.identity();
    this.requireRecoveryAuthority();
    const status = this.administrativeStatus;
    if (!identity || identity.instanceId !== this.instanceId || !recoveredStatus(status)) {
      throw new RemoteInstanceError("registration_mismatch", "Recovered provisioning identity is not authoritative.");
    }
    await this.store.saveIdentity({ ...identity, administrativeStatus: status });
    this.requireRecoveryAuthority();
    await this.store.clearProvisioning();
    this.provisioningCredential = null;
    this.provisioningLoopActive = false;
  }

  private async startOrdinaryLoops(): Promise<void> {
    if (!this.configurationTimer) {
      this.configurationTimer = setInterval(() => void this.refreshConfiguration(), 30_000);
      this.configurationTimer.unref();
    }
    if (!this.ordinaryHeartbeatStarted) {
      await this.heartbeat.start();
      this.ordinaryHeartbeatStarted = true;
    }
  }

  private beginActiveWork(): void {
    void this.resumeOnComputerWatches().catch(error => this.logger.warn({ err: error }, "on-computer steps not resumed"));
    this.transport.start();
    this.planningDirectivePoller?.start();
    this.transport.resumeAfterRecovery();
    this.pullTimer = setInterval(() => this.work.pull(), 5_000);
    this.pullTimer.unref();
    // Every 5 minutes, release sessions idle for 30 minutes.
    this.reaperTimer = setInterval(() => void this.work.reapIdleCompletedSessions(IDLE_SESSION_RELEASE_MS).catch(() => undefined), IDLE_SESSION_SWEEP_MS);
    this.reaperTimer.unref();
    this.previews.startIdleSweep();
    this.ensureUpdates()?.start();
    this.ensureRuntimeUpdates()?.start();
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
        // Only a release Core accepts is installed unattended.
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
      void this.ensureRuntimeUpdates()?.recover().catch(() => {
        this.logger.warn({ event: "runtime.update_report_pending" }, "runtime update outcome will be retried");
      });
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
    const instanceId = this.ownedRecoveryInstance();
    if (!instanceId) return null;
    const recovery = this.journal.recovery.current(instanceId, this.runnerIncarnation);
    if (!appliedRecovery(recovery)) return null;
    return JSON.stringify([instanceId, this.runnerIncarnation, this.leaseAuthorityEpoch, recovery.manifest.ownerRevision, recovery.manifest.manifestId, recovery.receipt.digest, recovery.acceptedAt]);
  }

  /** This process's instance while it owns its state under a usable lease after reconciliation; null otherwise. */
  private ownedRecoveryInstance(): string | null {
    if (this.stopping || !this.nativeOwnership || !this.instanceId || !this.leaseUsable() || !this.reconciliation?.isComplete) return null;
    try { this.nativeOwnership.assertOwned(); } catch { return null; }
    return this.instanceId;
  }

  private leaseUsable(): boolean {
    return this.lease.isValid() && this.lease.mode() !== "none";
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
      this.requestAutomaticSkillSync();
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
    if (!heartbeatMatchesClaims(result, claims, this.instanceId)) {
      throw new RemoteInstanceError("registration_mismatch", "Heartbeat lease metadata does not match its claims.");
    }
    if (claims.exp * 1000 <= this.clock.coreNow()) throw new RemoteInstanceError("temporarily_unavailable", "Heartbeat returned an expired lease.");
    await this.adoptLease(result.lease, assertCurrent);
    if (!this.stopping) this.heartbeatIntervalSeconds = result.heartbeatIntervalSeconds;
  }

  private async onHeartbeatFailure(error: unknown): Promise<void> {
    if (this.stopping) return;
    const code = error instanceof RemoteInstanceError ? error.code : "temporarily_unavailable";
    if (code === "instance_revoked" || code === "instance_suspended") await this.loseLeaseAuthority(code);
  }

  /** Core revoked or suspended this runtime: stop new work, forget the lease and close its sessions. */
  private async loseLeaseAuthority(code: "instance_revoked" | "instance_suspended"): Promise<void> {
    this.logger.error({ code }, "heartbeat renewal denied; stopping new work");
    this.administrativeStatus = code === "instance_revoked" ? "revoked" : "suspended";
    this.leaseAuthorityEpoch++;
    this.leaseRestorationAllowed = false;
    if (code === "instance_revoked") this.heartbeat.stop();
    this.lease.set(null);
    if (!this.draining) { this.draining = true; this.drainReason = "lease_lost"; }
    await this.mutateLease(() => this.store.clearLease());
    this.startLeaseLossCleanup();
  }

  /**
   * Cancellation is tracked, but never awaited inside lease acquisition:
   * a stuck local tool cannot prevent suspended heartbeat retries. New
   * work stays drained until both cleanup and fresh Core authority agree.
   */
  private startLeaseLossCleanup(): void {
    if (this.leaseLossCleanup) return;
    this.leaseLossCleanupFailed = false;
    this.leaseLossCleanup = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([this.previews.stopAll("lease_lost"), this.work.drainSessions("lease_lost")]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    })
      .catch(() => { this.leaseLossCleanupFailed = true; this.logger.error("lease-loss session or preview cleanup failed; work remains drained"); })
      .finally(() => { this.leaseLossCleanup = null; this.restoreLeaseDrain(); });
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
      case "control":
        return this.onControlMessage(message.body);
      case "assignment":
        return this.onAssignmentChannelMessage(message);
      case "session":
        await this.work.onSessionMessage(message.channelId, message.body);
        return;
      case "preview":
        // Answered asynchronously on the stream; receipt is not the response.
        this.previewChannel.onToRuntime(message.channelId, message.body);
        return;
    }
  }

  /** A control frame naming a manifest is reconciliation; any other is a control directive. */
  private async onControlMessage(body: unknown): Promise<void> {
    if ((body as { manifestId?: string }).manifestId !== undefined) {
      await this.reconciliation.apply(body);
      this.requestAutomaticSkillSync();
      return;
    }
    await this.control.handle(body);
  }

  /** A planning controller's terminal directive is stored and accepted; anything else is assignment work. */
  private async onAssignmentChannelMessage(message: InboundMessage): Promise<void> {
    const terminal = PlanningControllerTerminalDirectiveSchema.safeParse(message.body);
    if (terminal.success) {
      const instanceId = this.instanceId ?? "", afterSequence = this.journal.planning.cursor(instanceId);
      await this.journal.planning.storePulled(instanceId, afterSequence, { version: 1, directives: [terminal.data], highWater: terminal.data.directiveSequence });
      await this.planningTerminal.accept(terminal.data);
      return;
    }
    await this.work.onAssignmentMessage(message.body, message.assignmentRequest);
  }

  private async onChannelReset(channelId: string): Promise<void> {
    const channel = channelOf(channelId);
    if (channel === "session") await this.work.onChannelReset(channelId);
    else if (channel === "preview") this.previewChannel.closeChannel(channelId);
    else if (channel === "assignment" || channel === "observation") await this.work.reports.flushAll();
  }

  private async onRunnerEvent(agentId: string, event: Parameters<WorkOrchestrator["onRunnerEvent"]>[0]): Promise<void> {
    if (event.kind === "readiness_changed") this.onAgentReadinessChanged(event.agent);
    if (event.kind === "login_event") this.onLoginEvent(agentId, event);
    if (event.kind === "agent_scope_reset") { this.modelCapabilities?.invalidateAgent(agentId); this.logger.info({ agentId, previousScope: event.previousScope }, "agent_scope_reset"); }
    if (event.kind === "agent_scope_attested") this.modelCapabilities?.invalidateAgent(agentId);
    await this.work.onRunnerEvent(event);
  }

  private onAgentReadinessChanged(agent: Extract<SupervisorRunnerEvent, { kind: "readiness_changed" }>["agent"]): void {
    this.inventory.updateAgent(agent);
    if (this.lastSnapshot) this.lastSnapshot = { ...this.lastSnapshot, agents: this.inventory.agents() };
    const agents = this.inventory.agents();
    this.modelCapabilities?.invalidateForAgents(agents);
    void this.modelCapabilities?.refresh(agents).catch(error => this.logger.warn({ err: error }, "native model capability discovery failed"));
  }

  /** Relay a runner's sign-in event to the login that asked for it; a completed or failed sign-in ends it. */
  private onLoginEvent(agentId: string, event: Extract<SupervisorRunnerEvent, { kind: "login_event" }>): void {
    const login = this.activeLogins.get(event.loginId);
    if (!login) return;
    login.emit(mapLoginEvent(event.loginId, event.event));
    const type = event.event.type;
    if (type !== "completed" && type !== "failed") return;
    if (type === "completed") this.modelCapabilities?.invalidateAgent(agentId);
    this.activeLogins.delete(event.loginId);
  }

  // ── Outbound facts ─────────────────────────────────────────────────────────

  private async sendControlAck(ack: ControlAck): Promise<void> {
    if (ack.type === "desired_configuration_ack") {
      await this.configurationAcks.submit(ack);
      return;
    }
    await this.outbox.enqueue({ id: randomUUID(), channel: "control", key: controlAckKey(ack), group: "control", order: this.clock.now(), body: ack, createdAt: this.clock.nowIso() });
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
          void this.stopAtDrainDeadline().catch(() => this.logger.error("drain deadline session or preview cleanup failed; work remains drained"));
        }
      };
      expire();
    }
    // Previews of sessions still working stop with those sessions; the rest
    // (a finished turn's preview left open) stop now.
    const live = this.work.liveSessionIds();
    const previews = this.previews.list().filter(preview => !live.has(preview.sessionId));
    const stopped = await Promise.allSettled(previews.map(preview => this.previews.stop(preview.sessionId, "drain")));
    const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Detached preview cleanup remains unconfirmed; work remains drained.");
    this.logger.info({ reason, active }, "draining: no new claims");
    return active;
  }

  private async stopAtDrainDeadline(): Promise<void> {
    const stopped = await Promise.allSettled([this.work.drainSessions("drain"), this.previews.stopAll("drain")]);
    const failure = stopped.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
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
   * client appear here, and none may.
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
    const cwd = this.viewerPreviewWorktree(sessionId, current.state);
    if (cwd === null) return false;
    this.previewViewerStarts.set(sessionId, Date.now());
    const started = await this.previews.start(sessionId, cwd, "viewer");
    if (started.state !== "starting" && started.state !== "running") {
      this.logger.info({ event: "preview.viewer_start_refused", state: started.state }, "a viewer's preview could not start");
      return false;
    }
    this.logger.info({ event: "preview.viewer_started" }, "a viewer started this session's preview");
    return true;
  }

  /** The session's worktree when a viewer may start its preview now; null while stopping, draining, without an active lease or a worktree, or soon after a viewer start failed. */
  private viewerPreviewWorktree(sessionId: string, state: string): string | null {
    if (this.stopping || this.draining || this.lease.mode() !== "active") return null;
    const cwd = this.previewWorktrees.get(sessionId);
    if (cwd === undefined || !existsSync(cwd)) return null;
    return this.viewerRetryPending(sessionId, state) ? null : cwd;
  }

  private viewerRetryPending(sessionId: string, state: string): boolean {
    const last = this.previewViewerStarts.get(sessionId);
    return state === "failed" && last !== undefined && Date.now() - last < PREVIEW_VIEWER_RETRY_MS;
  }

  private forgetPreviewWorktree(sessionId: string): void {
    this.previewWorktrees.delete(sessionId);
    this.previewViewerStarts.delete(sessionId);
  }

  /**
   * Every agent's sessions get the QA browser while the connector has
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
    return { version, agents: agents.sort(), chrome: chromeInstalled(), ...connectorBrowserFields(this.connectorBrowser, version) };
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
    return {
      instanceId: this.instanceId,
      workspaceId: this.workspaceId,
      administrativeStatus: this.administrativeStatus,
      connectivity: this.connectivityStatus(),
      lease: this.leaseStatus(),
      version: this.versionStatus(),
      configRevision: this.control?.configRevision ?? 0,
      components: (this.lastSnapshot?.components ?? []).map((component) => ({ kind: component.kind, version: component.version, healthStatus: component.healthStatus, capabilities: component.capabilities, lastProbeAt: component.lastProbeAt })),
      roles: (this.heartbeat?.roles() ?? []) as SupervisorStatus["roles"],
      roleBindings: this.roleBindings,
      utilization: this.utilizationStatus(),
      pendingErase: this.journal.erase.all().filter((record) => !record.receiptSent).length,
      pendingRevocation: this.pendingRevocation,
      // Also read by launchers installed before 7.0.0, which require both fields.
      ...this.previewExposure(),
      journal: { assignments: this.journal.activeAssignments().length, outboxDepth: this.outbox.depth, recoveryRequired: this.journal.recoveryRequired().length },
    };
  }

  private connectivityStatus(): SupervisorStatus["connectivity"] {
    const relay = this.relay?.status();
    const relayConnected = relay?.state === "connected";
    return { transport: this.transportState(relayConnected), relayConnected, lastConnectedAt: relay?.lastConnectedAt ?? null, reconciliationComplete: this.reconciliation?.isComplete ?? false };
  }

  private transportState(relayConnected: boolean): SupervisorStatus["connectivity"]["transport"] {
    if (relayConnected) return "relay";
    return this.transport?.available ? "https_fallback" : "offline";
  }

  private leaseStatus(): SupervisorStatus["lease"] {
    const lease = this.lease.current();
    return { mode: this.lease.mode(), expiresAt: lease?.expiresAt ?? null, drainDeadline: lease?.drainDeadline ?? null };
  }

  private versionStatus(): SupervisorStatus["version"] {
    const policy = this.control?.versionPolicy;
    return { bundle: this.config.SUPERVISOR_BUNDLE_VERSION, protocol: String(REMOTE_INSTANCE_PROTOCOL_VERSION), manifestDigest: this.manifestDigest || null,
      updateAvailable: policy?.updateAvailable ?? false, targetBundle: policy?.targetBundle ?? null };
  }

  private utilizationStatus(): SupervisorStatus["utilization"] {
    return { acceptingWork: !this.draining && !this.onUpdateProbation && this.lease.canPullNewWork(), ...snapshotLoad(this.lastSnapshot),
      ...(this.configuration.softMaxConcurrent === undefined ? {} : { softMaxConcurrent: this.configuration.softMaxConcurrent }) };
  }

  private machineSkillSyncClient(): NativeSkillSyncClient {
    this.skillSyncClient ??= new NativeSkillSyncClient({
      baseUrl: this.config.SUPERVISOR_CORE_URL, roots: this.roots,
      now: () => this.clock.coreNow(), coreContractVersion: () => this.coreContractVersion,
      identity: () => ({ workspaceId: this.workspaceId ?? "", instanceId: this.instanceId ?? "" }),
      credential: () => !this.stopping && this.lease.mode() === "active" ? this.lease.current()?.lease ?? null : null,
    });
    return this.skillSyncClient;
  }

  private async syncSkills() {
    if (this.stopping || !this.options.native || !this.nativeOwnership || !this.reconciliation.isComplete) {
      throw new RemoteInstanceError("capability_unavailable", "Skill sync is unavailable until runtime recovery completes.");
    }
    this.nativeOwnership.assertOwned();
    const homes = machineSkillHomes(this.options.native.runners);
    const unavailableAgentIds = this.options.native.runners.filter(runner => machineSkillHomes([runner]).length === 0).map(runner => runner.RUNNER_AGENT_ID);
    this.skillSync ??= new SkillSyncCoordinator(signal => {
      this.assertSkillSyncReady();
      const client = this.machineSkillSyncClient();
      return runRequestedSkillSync(client, () => refreshMachineSkills({
      client, homes, unavailableAgentIds,
      scratchRoot: join(this.config.SUPERVISOR_DATA_DIR, "machine-skills"),
      owner: { workspaceId: this.workspaceId ?? "", instanceId: this.instanceId ?? "" },
      now: () => this.clock.coreNow(),
    }, signal), signal);
    });
    this.skillSync.startPeriodic(() => this.skillSyncReady(), () => this.logSkillSyncFailure());
    try { return { ...await this.skillSync.sync(), complete: true, loaded: "unknown" as const }; }
    catch (error) {
      if (error instanceof MachineSkillPartialFailure) return { ...error.inventory, complete: false, loaded: "unknown" as const };
      throw error;
    }
  }

  private skillSyncReady(): boolean {
    return !this.stopping && !!this.options.native && !!this.nativeOwnership && this.reconciliation.isComplete && this.lease.mode() === "active" && coreContractAtLeast(this.coreContractVersion, "7.5");
  }

  private assertSkillSyncReady(): void {
    if (!this.skillSyncReady()) throw new RemoteInstanceError("capability_unavailable", "Skill synchronization requires a recovered runtime, active lease and Core contract 7.5.");
    this.nativeOwnership!.assertOwned();
  }

  private logSkillSyncFailure(): void {
    this.logger.warn({ event: "skills.sync_failed" }, "Automatic Skill sync failed; retry with skills sync or inspect runtime readiness.");
  }

  private requestAutomaticSkillSync(): void {
    if (!this.skillSyncReady()) return;
    void this.syncSkills().then(report => { if (!report.complete) this.logSkillSyncFailure(); }, () => this.logSkillSyncFailure());
  }

  private async listSkills() {
    if (this.stopping || !this.options.native || !this.nativeOwnership || !this.reconciliation.isComplete) {
      throw new RemoteInstanceError("capability_unavailable", "Skill inventory is unavailable until runtime recovery completes.");
    }
    this.nativeOwnership.assertOwned();
    const envelope = await this.machineSkillSyncClient().prepare();
    return { skills: envelope.catalog.skills, catalogDigest: envelope.catalogDigest,
      installed: "unknown", loaded: "unknown" };
  }

  controlHandler(): ControlHandler {
    const ops = this.controlOps();
    return async (request, emit) => (ops[request.op] as (request: ControlRequest, emit: ControlEmitter) => unknown)(request, emit);
  }

  /** One handler per control-socket op. */
  private controlOps(): ControlOps {
    return {
      status: () => this.status(),
      "skills.list": () => this.listSkills(),
      "skills.sync": () => this.syncSkills(),
      agents: () => {
        const agents = this.lastSnapshot?.agents ?? this.inventory.agents();
        return { agents: [...agents, ...this.leftOutAgents(agents)], roles: this.heartbeat?.roles() ?? [], roleBindings: this.roleBindings };
      },
      "auth.status": request => ({ agents: (this.lastSnapshot?.agents ?? this.inventory.agents()).filter((agent) => request.agentId === undefined || agent.agentId === request.agentId) }),
      "auth.login": (request, emit) => this.localLogin(request, emit),
      "auth.input": async request => {
        const login = this.activeLogins.get(request.loginId);
        if (!login) throw new RemoteInstanceError("temporarily_unavailable", "no login in progress with that id");
        await this.requireRunner(login.agentId).loginInput(request.loginId, request.text);
        return {};
      },
      "auth.cancel": request => this.cancelLocalLogin(request.loginId),
      "auth.logout": request => {
        const which = { ...(request.provider === undefined ? {} : { provider: request.provider }), ...(request.method === undefined ? {} : { method: request.method }) };
        return Object.keys(which).length === 0 ? this.requireRunner(request.agentId).logout() : this.requireRunner(request.agentId).logout(which);
      },
      "git.key.add": request => this.addGitKey(request.title),
      "git.key.list": async () => ({ keys: await this.gitKeys().list() }),
      "git.key.remove": async request => {
        const store = this.gitKeys();
        await store.remove(request.keyRef);
        this.managedGitBinding = await store.binding();
        return { keyRef: request.keyRef, revoked: true };
      },
      drain: async request => ({ activeAssignments: await this.beginDrain(request.reason, null) }),
      "drain.status": () => this.drainStatus(),
      "codex.maintenance.preflight": async () => {
        if (!this.draining || this.drainReason !== "update" || this.work.activeCount() !== 0 || this.stopping) {
          throw new RemoteInstanceError("active_work", "The update drain has not settled for Codex maintenance.");
        }
        await this.nativeCodexOwner?.preflightMaintenance();
        return { idle: true };
      },
      "drain.cancel": () => this.cancelLocalDrain(),
      "update.check": () => this.requireUpdates().check(),
      "update.apply": () => this.requireUpdates().apply("operator"),
      "update.status": () => this.requireUpdates().status(),
      // Its own op, not a status field: launchers from older releases read
      // `status` strictly and a user install never replaces its launcher.
      "update.channel": () => {
        const channel = this.updates ? this.updateChannelReport() : null;
        return channel ? { host: channel.host, override: channel.override, lastCheckedAt: channel.lastCheckedAt, error: channel.lastError } : null;
      },
      "release.accepted": async () => {
        if (!this.instanceId) return { bundleVersion: null };
        const accepted = await this.core.acceptedRelease(this.instanceId);
        return { bundleVersion: accepted?.bundleVersion ?? null };
      },
      "preview.status": () => this.previewReport(),
      doctor: () => this.doctor(),
      logs: () => ({ lines: this.logLines.slice(-2_000) }),
      "support.bundle": () => this.supportBundle(),
      "readiness.submit": async () => {
        await this.continueProvisioning();
        return this.status();
      },
      "revoke.pending": () => {
        this.pendingRevocation = true;
        return { pendingRevocation: true };
      },
      // Answered first, then stopped, so the caller hears it was accepted.
      shutdown: () => {
        setTimeout(() => {
          if (this.options.onShutdownRequested) this.options.onShutdownRequested();
          else void this.stop().catch(() => undefined);
        }, 200).unref?.();
        return { stopping: true };
      },
      "instance.retire": () => this.retireInstance(),
    };
  }

  /** The person ran this on their own machine: their own login. */
  private async localLogin(request: ControlRequestOf<"auth.login">, emit: ControlEmitter): Promise<{ loginId: string }> {
    const runner = this.requireRunner(request.agentId);
    const loginId = `login-${randomUUID()}`;
    this.activeLogins.set(loginId, { agentId: request.agentId, emit: (event) => emit.event(event) });
    emit.signal.addEventListener("abort", () => {
      if (!this.activeLogins.delete(loginId)) return;
      void runner.loginCancel(loginId).catch(error => this.logger.warn({ err: error }, "orphaned local login cancellation failed"));
    }, { once: true });
    const which = localLoginSelection(request);
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

  private async cancelLocalLogin(loginId: string): Promise<Record<string, never>> {
    const login = this.activeLogins.get(loginId);
    if (!login) return {};
    this.activeLogins.delete(loginId);
    await this.requireRunner(login.agentId).loginCancel(loginId);
    login.emit({ kind: "failed", loginId, code: "login_cancelled", message: "login cancelled" });
    return {};
  }

  /**
   * The reference, the fingerprint and the host; never the key. The key
   * file's path lets the person's own git use the key for the repository
   * onboarding pushes; the key itself never leaves. The binding exists only
   * when the registration named a host.
   */
  private async addGitKey(title: string | undefined) {
    const store = this.gitKeys();
    const key = await store.add(title ?? `konteks-remote ${this.instanceId ?? "runtime"}`);
    this.managedGitBinding = await store.binding();
    return {
      keyRef: key.keyRef, title: key.title, fingerprint: key.fingerprint, host: key.host,
      sshConfig: sshConfigPath(this.config.SUPERVISOR_ONBOARD_GIT_KEY_DIR),
      identityFile: store.privateKeyPath,
      user: this.managedGitBinding?.user ?? "git",
    };
  }

  private drainStatus() {
    return { draining: this.draining, reason: this.drainReason, activeAssignments: this.work.activeCount(), openSessions: this.work.openSessions() };
  }

  /** Only a locally requested drain is reversible; a Core directive with a deadline stays in force until Core lifts it. */
  private cancelLocalDrain() {
    if (this.draining && this.drainDeadline === null) {
      this.draining = false;
      this.drainReason = null;
      if (this.administrativeStatus === "draining") this.administrativeStatus = "active";
      this.logger.info("drain cancelled by the local operator");
    }
    return this.drainStatus();
  }

  private async supportBundle() {
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

  /**
   * Removed from its workspace, a runtime has nothing left to do: it stops
   * once this answer is sent, so uninstall never deletes a folder out from
   * under a process still running in it.
   */
  private async retireInstance() {
    if (!this.instanceId) throw new RemoteInstanceError("temporarily_unavailable", "This runtime is not activated, so there is nothing to remove from Konteks.");
    const result = await this.core.retire(this.instanceId);
    if (result.outcome !== "draining") {
      this.administrativeStatus = "removed";
      setTimeout(() => {
        if (this.options.onRetired) this.options.onRetired();
        else void this.stop().catch(() => undefined);
      }, 500).unref?.();
    }
    return result;
  }

  private requireUpdates(): NativeUpdateCoordinator {
    if (!this.updates) throw new RemoteInstanceError("capability_unavailable", "Automatic updates are not configured for this connector.");
    return this.updates;
  }

  /**
   * A login the person started from the site for an agent on this machine.
   * Core signed it for this runtime; the runner runs the agent's
   * official device login in the person's own profile, and only the provider
   * link and code go back to Core. A login that asks for typed input is
   * stopped: nothing the person types may cross Konteks.
   */
  private async onAgentLogin(request: RuntimeAgentLoginDeliveryRequest, verifier: CoreSignatureVerifier): Promise<void> {
    if (!verifier.verifyAgentLoginDelivery(request)) {
      throw new RemoteInstanceError("permission_denied", "Core agent login signatures are required");
    }
    const { intent } = request;
    const instanceId = this.loginRuntime(intent);
    if (isOnComputerLogin(intent)) return this.startOnComputer(instanceId, intent.loginId, intent.agentId as OnComputerAgent, intent.action);
    const agentId = intent.agentId;
    if (!isSiteLoginAgent(agentId)) return this.refuseLoginAgent(instanceId, intent);
    const site = siteLoginSelection(intent);
    const report = this.siteLoginReporter(instanceId, intent.loginId, site.loginOption);
    if (intent.action === "cancel") return this.cancelSiteLogin(intent.loginId);
    // A repeated delivery of a login already under way changes nothing.
    if (this.activeLogins.has(intent.loginId)) return;
    const runner = this.runners.get(agentId);
    if (!runner || siteLoginRefused(agentId, site, runner)) {
      await report({ loginId: intent.loginId, agentId, state: "failed", failure: "unavailable" });
      return;
    }
    await this.startSiteLogin(intent.loginId, agentId, runner, site, report);
  }

  /** The runtime a signed login names: this one, or the login is refused. */
  private loginRuntime(intent: AgentLoginIntent): string {
    const instanceId = this.instanceId;
    if (!instanceId || intent.instanceId !== instanceId || intent.tenantId !== this.workspaceId) {
      throw new RemoteInstanceError("recovery_required", "This agent login is for another runtime");
    }
    return instanceId;
  }

  /** An agent this connector cannot sign in from the site: its start is reported unavailable. */
  private async refuseLoginAgent(instanceId: string, intent: AgentLoginIntent): Promise<void> {
    if (intent.action === "cancel") return;
    await this.core.reportAgentLogin(instanceId, { loginId: intent.loginId, agentId: intent.agentId, state: "failed", failure: "unavailable" } as AgentLoginReport)
      .catch(error => this.logger.warn({ err: error, loginId: intent.loginId }, "agent login report not delivered"));
  }

  /** Every report of a site sign-in echoes the sign-in option it named. */
  private siteLoginReporter(instanceId: string, loginId: string, loginOption: SiteLoginSelection["loginOption"]) {
    return (value: AgentLoginReport) =>
      this.core.reportAgentLogin(instanceId, { ...value, ...(loginOption === undefined ? {} : { loginOption }) } as AgentLoginReport)
        .catch(error => this.logger.warn({ err: error, loginId }, "agent login report not delivered"));
  }

  private async cancelSiteLogin(loginId: string): Promise<void> {
    const login = this.activeLogins.get(loginId);
    if (!login) return;
    this.activeLogins.delete(loginId);
    await this.requireRunner(login.agentId).loginCancel(loginId).catch(() => undefined);
  }

  private async startSiteLogin(loginId: string, agentId: SiteLoginAgent, runner: RunnerPort, site: SiteLoginSelection,
    report: (value: AgentLoginReport) => Promise<unknown>): Promise<void> {
    const { loginOption, gcp } = site;
    const relay = siteLoginRelay({ loginId, agentId, ...(loginOption === undefined ? {} : { loginOption }),
      coreAcceptsNoLicense: this.hostSettings.coreAcceptsRouteBilling,
      report: value => { void report(value); },
      cancel: () => { void runner.loginCancel(loginId).catch(() => undefined); },
      onFinished: () => { this.activeLogins.delete(loginId); },
      // Ready shows on the site now, not at the next heartbeat.
      onSucceeded: () => { if (this.activeLoopStarted) void this.heartbeat.publish().catch(error => this.logger.warn({ err: error }, "heartbeat after login failed")); },
    });
    this.activeLogins.set(loginId, { agentId, emit: event => relay.emit(event) });
    try {
      if (loginOption === undefined) await runner.login(false, loginId, true);
      else await runner.login(false, loginId, true, { loginOption, ...(gcp ? { gcp } : {}) });
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
  private async startOnComputer(instanceId: string, loginId: string, agentId: OnComputerAgent, action: "start" | "cancel",
  ): Promise<void> {
    const report = this.onComputerReporter(instanceId, loginId, agentId);
    if (action === "cancel") { await this.stopOnComputerWatch(loginId); return; }
    if (this.onComputerWatches.has(loginId)) return;
    const facts = this.onComputerFacts(agentId);
    if (!facts) { await report({ state: "failed", failure: "unavailable" }); return; }
    if (onComputerDone(facts.state)) { await report({ state: "succeeded" }); return; }
    const plan = onComputerPlan(agentId, facts);
    if (!plan) { await report({ state: "failed", failure: "unavailable" }); return; }
    if (!(await this.openOnComputerStep(loginId, agentId, plan))) {
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

  /** Bring the step's window to the front; false when it could not be opened. */
  private async openOnComputerStep(loginId: string, agentId: OnComputerAgent, plan: OnComputerPlan): Promise<boolean> {
    const root = dirname(this.config.SUPERVISOR_DATA_DIR);
    // A stand-in laptop's window loads the stand-in's own terminal settings.
    const prelude = process.env.KONTEKS_E2E_NATIVE_CONNECTOR === "1" ? standInTerminalEnv(root) : undefined;
    // This release's own launcher, never the install-day one in bin (it is not updated).
    const launcher = releaseLauncher();
    try {
      const { file, opened } = await openOnComputer({ loginId, script: onComputerScript(plan, { agentId, root, platform: process.platform, ...(prelude ? { prelude } : {}), ...(launcher ? { launcher } : {}) }), dataDir: this.config.SUPERVISOR_DATA_DIR, platform: process.platform, confined: prelude !== undefined });
      this.logger.info({ event: opened ? "on_computer.opened" : "on_computer.left_for_tester", loginId, agentId, step: plan.step, file },
        opened ? "site-started step brought to the front on this computer" : "site-started step left in the stand-in's folder; no window opened");
      return true;
    } catch (error) {
      this.logger.warn({ err: error, loginId, agentId }, "site-started step could not be opened on this computer");
      return false;
    }
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
   * the runtime's busy bar and counter move with the work, and a short turn
   * never falls between two 30 s heartbeats unseen.
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
   * Zen's free models (absent = off) and whether Core takes 7.1 fields
   * (pay-per-use turns and route billing, an offered option's billing,
   * `hostAgentDownload`, a credential's and a site sign-in's `no_license`).
   * The latter is the Core wire-contract version Core signs into every
   * revision for a connector advertising `core-contract-version-v1`
   * (inventory.ts); no fallback on the free-models field, which no released
   * Core ever sent. A change drops OpenCode's model
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
   * for `agents` and `doctor`, so the update health gate never waits for the
   * probe of an agent left out at start. Only agents this release
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
   * Every supported agent's real state on this computer,
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
    for (const agentId of this.recordedAgentIds()) added.set(agentId, this.addedAgentFacts(agentId, agents));
    return projectSupportedAgents({ added, notAdded: detector.current() });
  }

  /** A listed agent from its live runner's view, or from why it is left out. */
  private addedAgentFacts(agentId: string, agents: readonly ConnectedAgentView[]): AddedAgentFacts {
    const live = this.liveNativeRunner(agentId);
    const view = live ? agents.find(agent => agent.agentId === agentId) : undefined;
    const version = this.runnerInstallation(agentId, live)?.version;
    const versionField = version ? { version } : {};
    return live && view
      ? { view, signInLost: live.signInLost(), ...versionField }
      : { failure: this.agentStartFailures.get(agentId), ...versionField };
  }

  /** What this connector advertises for OpenCode: the free-models switch, and the sign-ins the site may start here. */
  private openCodeCapabilities(): string[] {
    const runner = this.runners.get("opencode");
    return openCodeRunnerCapabilities({ installed: runner !== undefined, relayReady: !this.stopping && this.relay !== null && this.relay !== undefined,
      options: runner?.siteLoginOptions?.() ?? [], desktop: machineHasDesktop() });
  }

  /**
   * Google Antigravity's download state on its connected agent,
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
    // shows "Not added" with the one command, or the download while
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
    const live = this.runnerInstallation("antigravity", this.nativeRunners.find(candidate => candidate.agentId === "antigravity"));
    if (live?.fetchedRoot !== undefined) return { antigravityVersion: live.version, antigravityRoot: live.fetchedRoot };
    return listedAntigravityFields(native);
  }

  /** What this connector advertises for Google Antigravity: its Gemini Enterprise sign-in from the site. */
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
    const inputs = {
      ...this.doctorState(snapshot),
      ...(openCode ? { openCode } : {}),
      ...(antigravity ? { antigravity } : {}),
      ...(this.updates ? { updateChannel: this.updateChannelReport() } : {}),
    };
    return runDoctor({ ...inputs, ...(await this.doctorLauncher()) });
  }

  private doctorState(snapshot: InventorySnapshot) {
    return {
      now: () => this.clock.nowIso(),
      dataDir: this.config.SUPERVISOR_DATA_DIR,
      identity: { instanceId: this.instanceId, administrativeStatus: this.administrativeStatus },
      lease: { mode: this.lease.mode(), expiresAt: this.lease.current()?.expiresAt ?? null },
      relay: this.relay?.status() ?? { state: "offline" as const, lastError: "relay not configured", consecutiveFailures: 0 },
      transport: this.transport.kind,
      reconciliationComplete: this.reconciliation.isComplete,
      ...(this.reconnectRefusal ? { reconciliationRefusal: this.reconnectRefusal } : {}),
      components: snapshot.components,
      agents: [...snapshot.agents, ...this.leftOutAgents(snapshot.agents)],
      // The snapshot may carry the site's "Not added" Google Antigravity view
      // (only after a fresh collect): an update gate must not read it as a failure.
      ...(this.options.native ? { listedAgents: [...this.recordedAgentIds()] } : {}),
      configRevision: this.control.configRevision,
      diskFreeBytes: snapshot.diskFreeBytes,
      // Native releases name no disk minimum; the check reports free space only.
      minimumDiskBytes: 0,
      outboxDepth: this.outbox.depth,
      recoveryRequired: this.journal.recoveryRequired().length,
      coreSignatureConfigured: this.roots.some((root) => (root.coreControlKeys ?? []).length > 0),
      preview: this.previewDoctorReport(),
      browser: this.browserReport(),
    };
  }

  private previewDoctorReport() {
    const health = this.previews.health();
    return { advertised: this.previewCapable(), running: health.running, lastFailureAt: health.lastFailure?.at ?? null };
  }

  /** The Windows installed launcher, for a native connector on Windows only. */
  private async doctorLauncher() {
    if (!this.options.native || process.platform !== "win32") return {};
    return { launcher: await windowsInstalledLauncher().catch(() => null) };
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
    const listed = this.listedAgentRunner("antigravity");
    if (!listed) return undefined;
    const root = dirname(this.config.SUPERVISOR_DATA_DIR);
    const pin = currentAntigravityPin();
    const download = await antigravityDownloadStateOf(root, this.antigravityRecordFields());
    const failure = this.agentStartFailures.get("antigravity");
    const updating = listed.retrying && this.antigravityUpdating();
    const observation = await readAntigravityAdminObservation(join(root, "credentials", "antigravity")).catch(() => null);
    return {
      state: listed.state,
      pinnedVersion: pin?.version ?? null,
      ...(download === undefined ? {} : { download }),
      selfCheck: selfCheckOf(listed.installation),
      failure: startFailureDiagnostic(failure),
      updating,
      credentials: agentCredentials(agents, "antigravity")
        .map(credential => ({ label: credential.label, state: credential.state, method: credential.method, reason: credential.reason })),
      quarantine: quarantineOf(listed.running),
      mcpServersOffAt: observation?.mcpServersOffAt ?? null,
      diskBytes: downloadedAntigravityDiskBytes(pin, download),
      browser: this.agentBrowser(listed.running),
    };
  }

  /** A retried Google Antigravity is updating when the installation marks its left-out copy so. */
  private antigravityUpdating(): boolean {
    return (
      this.options.native?.unavailableAgents?.some(entry => entry.agentId === "antigravity" && entry.updating === true) === true
    );
  }

  /**
   * A listed agent's runner for its doctor line: running, retried or given up,
   * or none of those but a start failure; undefined when the installation does not list it.
   */
  private listedAgentRunner(agentId: string): ListedAgentRunner | undefined {
    const running = this.liveNativeRunner(agentId);
    const retrying = this.nativeAgentRetry.parked().includes(agentId);
    const gaveUp = this.gaveUpRunners.get(agentId);
    if (!running && !retrying && !gaveUp && !this.agentStartFailures.has(agentId)) return undefined;
    return { running, retrying, state: doctorRunnerState(running, retrying), installation: this.runnerInstallation(agentId, running) ?? null };
  }

  /** The runner serving this agent now. */
  private liveNativeRunner(agentId: string): NativeRunner | undefined {
    return this.nativeRunners.find(runner => runner.agentId === agentId && this.runners.get(agentId) === runner);
  }

  /** The installation of the given runner, else the agent's parked one, else its given-up one. */
  private runnerInstallation(agentId: string, runner: NativeRunner | undefined): HostInstallation | null | undefined {
    return (runner ?? this.parkedRunners.get(agentId) ?? this.gaveUpRunners.get(agentId))?.hostInstallation();
  }

  /** A running agent reports its own browser; otherwise the connector's. */
  private agentBrowser(running: NativeRunner | undefined): boolean {
    return running ? running.browserVersion() !== null : this.connectorBrowser.available;
  }

  /** The OpenCode doctor line's facts, when this installation lists OpenCode (running, retried or given up). */
  private openCodeDoctor(agents: Array<{ agentId: string; credentials?: Array<{ label: string; state: string }> | undefined }>): OpenCodeDoctorInputs | undefined {
    const listed = this.listedAgentRunner("opencode");
    if (!listed) return undefined;
    const { installation } = listed;
    return {
      state: listed.state,
      version: installation?.version ?? null,
      installKind: installation?.executable ? openCodeInstallKind(installation.executable) : null,
      selfCheck: selfCheckOf(installation),
      failure: startFailureDiagnostic(this.agentStartFailures.get("opencode")),
      credentials: agentCredentials(agents, "opencode").map(credential => ({ label: credential.label, state: credential.state })),
      freeModels: this.hostSettings.openCodeFreeModels,
      browser: this.agentBrowser(listed.running),
    };
  }

  stop(): Promise<void> {
    this.leaseAuthorityEpoch++;
    this.stopping = true;
    this.skillSync?.stop();
    // Before anything that can outlast the daemon's exit watchdog.
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
    await this.noteShutdown("supervisor_prelude", "entered");
    await this.stopLoopsForShutdown();
    await this.noteShutdown("supervisor_prelude", "completed");
    await this.drainForShutdown();
    await this.noteShutdown("preview_close", "entered");
    const previewFailure = await this.closePreviewsForShutdown();
    this.previewChannel?.dispose();
    const { runnerFailure, codexFailure } = await this.stopAgentsForShutdown();
    for (const runner of this.runners.values()) runner.stopEvents();
    this.transport?.stop();
    await this.noteShutdown("state_close", "entered");
    await this.stateMutations.close();
    this.nativeOwnership?.release();
    if (previewFailure) throw previewFailure.reason;
    if (runnerFailure) throw runnerFailure.reason;
    if (codexFailure) throw codexFailure.reason;
  }

  private async closePreviewsForShutdown(): Promise<{ reason: unknown } | null> {
    try {
      await this.previews.close();
      await this.noteShutdown("preview_close", "completed");
      return null;
    } catch (reason) {
      this.logger.error("preview shutdown remains unconfirmed; retained owners fence restart");
      return { reason };
    }
  }

  /** Diagnostics must never prevent cleanup or change the shutdown receipt. */
  private async noteShutdown(phase: ShutdownProgress["phase"], state: ShutdownProgress["state"]): Promise<void> {
    if (!this.options.native) return;
    await this.shutdownProgressStore.recordShutdownProgress(phase, state).catch((err: unknown) => {
      this.logger.warn({ err }, "shutdown progress could not be recorded");
    });
  }

  /** Every shutdown wait that takes longer than a few seconds is named in the log, so a hung stop shows which wait holds it. */
  private async waitForShutdownStep(step: string, pending: Promise<unknown> | null | undefined): Promise<void> {
    if (!pending) return;
    const slow = setTimeout(() => this.logger.warn({ event: "shutdown.waiting", step }, "shutdown is still waiting"), 5_000);
    slow.unref?.();
    try { await pending; } finally { clearTimeout(slow); }
  }

  /** Stop every timer and poller, and wait for what they already started. */
  private async stopLoopsForShutdown(): Promise<void> {
    await this.waitForShutdownStep("start", this.startPromise?.catch(() => undefined));
    await this.waitForShutdownStep("active_loop_start", this.activeLoopStarting);
    this.stopWorkTimers();
    await this.waitForShutdownStep("skill_sync", this.skillSync?.settle());
    await this.waitForShutdownStep("cancellation_replay", this.cancellationReplay?.stop());
    stopInterval(this.configurationTimer);
    await this.settleControlLoops();
    this.heartbeat?.stop();
    await this.waitForShutdownStep("heartbeat", this.heartbeat?.settle());
    await this.waitForShutdownStep("lease_acquisition", this.leaseAcquisition);
    await this.waitForShutdownStep("lease_mutation", this.leaseMutation);
    await this.waitForShutdownStep("lease_loss_cleanup", this.leaseLossCleanup);
  }

  private stopWorkTimers(): void {
    stopInterval(this.pullTimer);
    for (const watch of this.onComputerWatches.values()) clearInterval(watch);
    this.onComputerWatches.clear();
    stopTimeout(this.turnActivityTimer);
    this.turnActivityTimer = null;
    stopInterval(this.reaperTimer);
    stopInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.updates?.stop();
    this.runtimeUpdates?.stop();
    stopInterval(this.muxTimer);
    stopInterval(this.cancellationTimer);
  }

  private async settleControlLoops(): Promise<void> {
    await this.waitForShutdownStep("configuration_refresh", this.configurationRefresh);
    await this.waitForShutdownStep("observation_delivery", this.observationDelivery?.stop());
    await this.waitForShutdownStep("configuration_acks", this.configurationAcks?.settle());
    await this.waitForShutdownStep("fence_receipts", this.executionRevisionFenceReceipts?.settle());
    await this.waitForShutdownStep("planning_directives", this.planningDirectivePoller?.stop());
  }

  /**
   * stop() withdrew this process's recovery authority first, so a session
   * whose close asserts it is refused ("Transport recovery generation is not
   * currently accepted"). That must not abort the stop before the runners
   * and the Codex owner are stopped, or Codex is orphaned and no receipt is
   * written; the session stays journaled for recovery.
   */
  private async drainForShutdown(): Promise<void> {
    await this.noteShutdown("work_drain", "entered");
    try {
      await this.work?.drainSessions("drain");
      await this.noteShutdown("work_drain", "completed");
    } catch (error) {
      this.logger.warn({ event: "shutdown.session_close_unconfirmed", code: error instanceof RemoteInstanceError ? error.code : "unexpected_error" },
        "an open session could not close during shutdown; stopping its agent anyway, the next start recovers it");
    }
  }

  /**
   * Runners stop side by side: one after another, an idle connector's bridges
   * take 5 s and launchd's SIGKILL comes before the Codex owner is reached.
   * A runner that cannot stop does not keep the others, the Codex owner or
   * the state from stopping; its failure is reported once all are done.
   */
  private async stopAgentsForShutdown(): Promise<{ runnerFailure: PromiseRejectedResult | undefined; codexFailure: { reason: unknown } | null }> {
    await this.noteShutdown("runner_stop", "entered");
    const runnerStops = await Promise.allSettled(this.nativeRunners.map(runner => runner.stop()));
    const runnerFailure = runnerStops.find((stop): stop is PromiseRejectedResult => stop.status === "rejected");
    const codexUnstopped = runnerStops.some((stop, index) => stop.status === "rejected" && this.nativeRunners[index]?.agentId === "codex");
    if (!runnerFailure) await this.noteShutdown("runner_stop", "completed");
    const codexFailure = await this.stopCodexOwnerForShutdown(codexUnstopped);
    stopTimeout(this.codexRetryTimer);
    this.codexRetryTimer = null;
    this.parkedCodex = null;
    this.nativeAgentRetry.stop();
    for (const runner of this.parkedRunners.values()) await runner.stop().catch(() => undefined);
    this.parkedRunners.clear();
    return { runnerFailure, codexFailure };
  }

  /**
   * The shared Codex app-server is stopped here only once every Codex runner
   * stopped; otherwise the exit reaper armed by stop() ends it with the process.
   */
  private async stopCodexOwnerForShutdown(codexUnstopped: boolean): Promise<{ reason: unknown } | null> {
    await this.noteShutdown("codex_owner_stop", "entered");
    if (codexUnstopped) return null;
    const failure = await stopCodexOwner(this.nativeCodexOwner);
    if (!failure) await this.noteShutdown("codex_owner_stop", "completed");
    return failure;
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
      return (
        ledger?.attempts.some(attempt => attempt.outcome === "in_progress" && attempt.releaseId === probation.releaseId &&
        Date.now() - Date.parse(attempt.startedAt) < staleMs) ?? false
      );
    };
    if (!(await checking())) return;
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

type ControlRequestOf<Op extends ControlRequest["op"]> = Extract<ControlRequest, { op: Op }>;
type ControlOps = { [Op in ControlRequest["op"]]: (request: ControlRequestOf<Op>, emit: ControlEmitter) => unknown };

/** The provider, method, reuse and Gemini Enterprise project and location a local sign-in names; the runner checks them again. */
function localLoginSelection(request: ControlRequestOf<"auth.login">) {
  return { ...(request.provider === undefined ? {} : { provider: request.provider }), ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.reuse === undefined ? {} : { reuse: request.reuse }),
    ...(request.project !== undefined && request.location !== undefined ? { gcp: AgentLoginGcpSchema.parse({ project: request.project, location: request.location }) } : {}) };
}

/** Sessions, turns and host pressure from the last inventory snapshot; zero before the first. */
function snapshotLoad(snapshot: InventorySnapshot | null) {
  return { activeSessions: snapshot?.activeSessions ?? 0, activeTurns: snapshot?.activeTurns ?? 0, utilizationRatio: Math.min(1, snapshot?.hostPressure ?? 0) };
}

/** The connector's QA browser package and Node, or why there is none when no agent offers one. */
function connectorBrowserFields(browser: ConnectorBrowserStatus, version: string | null) {
  if (browser.available) return { packageAgent: browser.browser.packageAgent, nodeSource: browser.browser.nodeSource };
  return version === null && browser.message ? { unavailable: browser.message } : {};
}

type AgentLoginIntent = RuntimeAgentLoginDeliveryRequest["intent"];
type AgentLoginReport = Parameters<CoreClient["reportAgentLogin"]>[1];
type SiteLoginAgent = "codex" | "claude-code" | "opencode" | "antigravity";

function isSiteLoginAgent(agentId: string): agentId is SiteLoginAgent {
  return (
    agentId === "codex" || agentId === "claude-code" || agentId === "opencode" || agentId === "antigravity"
  );
}

function isOnComputerLogin(intent: AgentLoginIntent): boolean {
  return (
    intent.loginOption === ON_COMPUTER_LOGIN_OPTION && (ON_COMPUTER_AGENTS as readonly string[]).includes(intent.agentId)
  );
}

type SiteLoginSelection = ReturnType<typeof siteLoginSelection>;

/**
 * An OpenCode or Antigravity login names its sign-in option; every report
 * echoes it. Another agent's option is never started (the runner offers
 * only its own). Gemini Enterprise carries its Google Cloud project.
 */
function siteLoginSelection(intent: AgentLoginIntent) {
  const optionAgent = intent.agentId === "opencode" || intent.agentId === "antigravity";
  const requestedOption = optionAgent && intent.loginOption !== undefined ? AgentLoginOptionIdSchema.safeParse(intent.loginOption) : undefined;
  const loginOption = requestedOption?.success ? requestedOption.data : undefined;
  return { requestedOption, loginOption, gcp: geminiEnterpriseProject(intent, loginOption) };
}

function geminiEnterpriseProject(intent: AgentLoginIntent, loginOption: string | undefined) {
  return intent.agentId === "antigravity" && loginOption === "gemini-enterprise" && intent.gcp !== undefined ? intent.gcp : undefined;
}

/** A sign-in this machine does not offer (any more) is not started; nor a Gemini Enterprise sign-in without its project. */
function siteLoginRefused(agentId: SiteLoginAgent, site: SiteLoginSelection, runner: RunnerPort): boolean {
  return siteLoginOptionRefused(site, runner) || antigravityLoginIncomplete(agentId, site);
}

function siteLoginOptionRefused(site: SiteLoginSelection, runner: RunnerPort): boolean {
  if (site.requestedOption !== undefined && !site.requestedOption.success) return true;
  return (
    site.loginOption !== undefined && !(runner.siteLoginOptions?.() ?? []).includes(site.loginOption)
  );
}

function antigravityLoginIncomplete(agentId: SiteLoginAgent, site: SiteLoginSelection): boolean {
  return (
    agentId === "antigravity" && (site.loginOption === undefined || (site.loginOption === "gemini-enterprise" && site.gcp === undefined)));
}

function onComputerPlan(agentId: OnComputerAgent, facts: { state: Parameters<typeof planOnComputer>[0]["state"]; installCommand?: string | undefined; windowsInstallCommand?: string | undefined }): OnComputerPlan | null {
  return planOnComputer({ agentId, state: facts.state, ...(facts.installCommand ? { installCommand: facts.installCommand } : {}),
    ...(facts.windowsInstallCommand ? { windowsInstallCommand: facts.windowsInstallCommand } : {}) }, process.platform);
}

type SupervisorRunnerEvent = Parameters<WorkOrchestrator["onRunnerEvent"]>[0];

/** Statuses a recovered provisioning identity may hold once Core committed its readiness. */
function recoveredStatus(status: string): status is "active" | "draining" | "suspended" {
  return status === "active" || status === "draining" || status === "suspended";
}
/** Core refuses this runtime itself. */
const REVOKED_CODES = ["instance_revoked", "registration_mismatch"] as const;
/** Core refuses this process's recovery generation for good. */
const RETIRED_CODES = ["reconciliation_replay", "resume_deadline_expired"] as const;

function remoteErrorCodeIn(error: unknown, codes: readonly string[]): boolean {
  return error instanceof RemoteInstanceError && codes.includes(error.code);
}

/** The first five call sites of an error's stack, innermost first, when it has one. */
function stackField(error: unknown): { at?: string } {
  const at = error instanceof Error ? error.stack?.split("\n").slice(1, 6).map(line => line.trim().replace(/^at /, "")).join(" < ") : undefined;
  return at ? { at } : {};
}

/** A recovery record past pending and applied: this incarnation's recovery ended. */
function recoveryEnded(record: RuntimeRecoveryRecord | undefined): boolean {
  return record !== undefined && record.state !== "pending" && record.state !== "applied";
}

type AppliedRecovery = RuntimeRecoveryRecord & {
  manifest: NonNullable<RuntimeRecoveryRecord["manifest"]>;
  receipt: NonNullable<RuntimeRecoveryRecord["receipt"]>;
  acceptedAt: NonNullable<RuntimeRecoveryRecord["acceptedAt"]>;
};

function appliedRecovery(recovery: RuntimeRecoveryRecord | undefined): recovery is AppliedRecovery {
  return (
    recovery?.state === "applied" && Boolean(recovery.manifest) && Boolean(recovery.receipt) && Boolean(recovery.acceptedAt)
  );
}

function heartbeatDrainDeadline(result: HeartbeatResult): number | undefined {
  return result.drainDeadline === undefined ? undefined : parseRfc3339(result.drainDeadline) / 1000;
}

/** The heartbeat's lease metadata matches the claims of the lease it carries. */
function heartbeatMatchesClaims(result: HeartbeatResult, claims: ReturnType<typeof decodeLeaseClaims>, instanceId: string | null,
): boolean {
  return (
    result.instanceId === instanceId && result.leaseMode === claims.lease_mode &&
    parseRfc3339(result.leaseExpiresAt) === claims.exp * 1000 && heartbeatDrainDeadline(result) === claims.drain_deadline
  );
}

/** One outbox key per directive, rotation or acknowledged version of a control ACK. */
function controlAckKey(ack: ControlAck): string {
  if ("directiveId" in ack) return `control:${ack.directiveId}`;
  if ("rotationId" in ack) return `control:${ack.rotationId}`;
  if ("revision" in ack) return `control:${ack.type}:${ack.revision}`;
  return `control:${ack.type}:${ack.type === "version_ack" ? ack.bundleVersion : ack.acknowledgedAt}`;
}

type NativeOptions = NonNullable<SupervisorOptions["native"]>;
type StoredIdentity = NonNullable<Awaited<ReturnType<SupervisorStore["identity"]>>>;
type StoredManifest = NonNullable<Awaited<ReturnType<SupervisorStore["manifest"]>>>;
type StoredLease = NonNullable<Awaited<ReturnType<SupervisorStore["lease"]>>>;
type RelayHandler<Name extends keyof RelayClientOptions> = NonNullable<RelayClientOptions[Name]> extends (...args: infer Args) => unknown ? Args : never;
type RelayRequestOf<Name extends keyof RelayClientOptions> = RelayHandler<Name>[0];
type RelayConnectionOf<Name extends keyof RelayClientOptions> = RelayHandler<Name>[1];
type DiagnosticCompanionRecord = Parameters<NonNullable<ConstructorParameters<typeof DiagnosticCompanionReceiver>[0]["onAccepted"]>>[0];

interface CapturedOwner {
  readonly lease: ReturnType<LeaseState["current"]>;
  readonly instanceId: string | null;
  readonly workspaceId: string | null;
  readonly runnerIncarnation: string;
  readonly ownership: Supervisor["nativeOwnership"];
}

function drainDeadlineMs(drainDeadline: string | null): number | null {
  return drainDeadline === null ? null : Date.parse(drainDeadline);
}

/** The stored lease's metadata matches the record its decoded claims make. */
function sameLeaseRecord(stored: StoredLease, expected: ReturnType<typeof leaseRecordFromClaims>,
): boolean {
  return (
    stored.mode === expected.mode &&
    Date.parse(stored.expiresAt) === Date.parse(expected.expiresAt) &&
    Date.parse(stored.issuedAt) === Date.parse(expected.issuedAt) &&
    drainDeadlineMs(stored.drainDeadline) === drainDeadlineMs(expected.drainDeadline)
  );
}

/** A new token/expiry alone does not change a captured managed update's policy. */
function sameRuntimeUpdateLeasePolicy(captured: ReturnType<typeof decodeLeaseClaims>, current: ReturnType<typeof decodeLeaseClaims>): boolean {
  return current.iat >= captured.iat &&
    allEqual([
      [captured.sub, current.sub], [captured.workspace_id, current.workspace_id],
      [captured.protocol, current.protocol], [captured.bundle_version, current.bundle_version],
      [captured.ownership_scope, current.ownership_scope], [captured.administrative_status, current.administrative_status],
      [captured.lease_mode, current.lease_mode],
      [captured.drain_deadline, current.drain_deadline],
    ]);
}

/** The journal entry is still the live claim of exactly this assignment's placement, kind and agent. */
function claimMatchesTarget(entry: JournalEntry, target: RemoteWorkAssignment): boolean {
  return (
    entry.workspaceId === target.workspaceId && entry.placementId === target.placementId && entry.kind === target.kind &&
    entry.agentId === target.agentRoute.agentId && ["claimed", "running", "checkpointed"].includes(entry.state)
  );
}

function stopInterval(timer: NodeJS.Timeout | null): void {
  if (timer) clearInterval(timer);
}

function stopTimeout(timer: NodeJS.Timeout | null): void {
  if (timer) clearTimeout(timer);
}

/** Stop the shared Codex owner: its refusal, or null once stopped (or when there is none). */
async function stopCodexOwner(owner: NativeCodexAppServerOwner | null): Promise<{ reason: unknown } | null> {
  try {
    await owner?.stop();
    return null;
  } catch (reason) {
    return { reason };
  }
}

type HostInstallation = NonNullable<ReturnType<NativeRunner["hostInstallation"]>>;

interface ListedAgentRunner {
  readonly running: NativeRunner | undefined;
  readonly retrying: boolean;
  readonly state: "running" | "retrying" | "given_up";
  readonly installation: HostInstallation | null;
}

function doctorRunnerState(running: NativeRunner | undefined, retrying: boolean): ListedAgentRunner["state"] {
  if (running) return "running";
  return retrying ? "retrying" : "given_up";
}

function selfCheckOf(installation: HostInstallation | null): HostInstallation["selfCheck"] {
  return installation?.selfCheck ?? "not_run";
}

function startFailureDiagnostic(failure: unknown) {
  return failure instanceof RemoteInstanceError ? failure.diagnostic : undefined;
}

function agentCredentials<Credential>(agents: ReadonlyArray<{ agentId: string; credentials?: Credential[] | undefined }>, agentId: string): Credential[] {
  return agents.find(agent => agent.agentId === agentId)?.credentials ?? [];
}

function quarantineOf(running: NativeRunner | undefined) {
  return running?.quarantineReason() ?? null;
}

/** The copy the installation's load named: a left-out agent's fetched copy, else its runner configuration's; null when unlisted. */
function listedAntigravityFields(native: NonNullable<SupervisorOptions["native"]>): Pick<NativeRuntimeRecord, "antigravityVersion" | "antigravityRoot"> | null {
  const unavailable = native.unavailableAgents?.find(entry => entry.agentId === "antigravity");
  if (unavailable) return unavailable.fetched ?? {};
  const config = native.runners.find(candidate => candidate.RUNNER_AGENT_ID === "antigravity");
  if (config?.RUNNER_NATIVE_ANTIGRAVITY_ROOT === undefined) return null;
  return { antigravityVersion: config.RUNNER_BRIDGE_VERSION, antigravityRoot: config.RUNNER_NATIVE_ANTIGRAVITY_ROOT };
}

/** The pinned Google Antigravity copy, or null when this build names none. */
function currentAntigravityPin(): ReturnType<typeof antigravityPin> | null {
  try { return antigravityPin(); } catch { return null; }
}

async function antigravityDownloadStateOf(root: string, record: Pick<NativeRuntimeRecord, "antigravityVersion" | "antigravityRoot"> | null) {
  if (record === null) return undefined;
  return (await antigravityDownloadState(root, record).catch(() => undefined))?.state;
}

/** Disk use is known once the pinned copy is downloaded. */
function downloadedAntigravityDiskBytes(pin: ReturnType<typeof antigravityPin> | null, download: string | undefined): number | null {
  return pin && (download === "ready" || download === "update_available") ? antigravityDiskBytes(pin) : null;
}

function flattenKeys(value: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) keys.push(...flattenKeys(entry as Record<string, unknown>, full));
    else keys.push(full);
  }
  return keys;
}

interface RunnerLoginEvent { type: string; text?: string | undefined; url?: string | undefined; userCode?: string | undefined; label?: string | undefined; secret?: boolean | undefined; visible?: true | undefined; readiness?: string | undefined; code?: string | undefined; message?: string | undefined; reason?: "no_license" | undefined }

const LOGIN_EVENTS = new Map<string, (loginId: string, event: RunnerLoginEvent) => ControlLoginEvent>([
  ["display", (loginId, event) => ({ kind: "display", loginId, text: event.text ?? "" })],
  ["open_url", (loginId, event) => ({ kind: "open_url", loginId, url: event.url ?? "", ...(event.userCode ? { userCode: event.userCode } : {}) })],
  ["prompt", (loginId, event) => ({ kind: "prompt", loginId, label: event.label ?? "", secret: event.secret ?? true,
    ...(event.visible === true && event.secret === false ? { visible: true as const } : {}) })],
  ["completed", (loginId, event) => ({ kind: "completed", loginId, readiness: event.readiness ?? "unknown" })],
]);

/** Any other runner login event ends the sign-in as failed. */
function failedLoginEvent(loginId: string, event: RunnerLoginEvent): ControlLoginEvent {
  return { kind: "failed", loginId, code: event.code ?? "agent_auth_required", message: event.message ?? "login failed",
    ...(event.reason === "no_license" ? { reason: "no_license" as const } : {}) };
}

function mapLoginEvent(loginId: string, event: RunnerLoginEvent): ControlLoginEvent {
  return (LOGIN_EVENTS.get(event.type) ?? failedLoginEvent)(loginId, event);
}
